# VPN PoC

AWS Site-to-Site VPN の動作確認を目的とした CDK プロジェクトです。
同一 AWS アカウント内に「AWS 側 VPC」と「仮想オンプレ側 VPC」を作成し、S2S VPN で接続します。

## アーキテクチャ

```
┌─────────────────────────────────┐        ┌──────────────────────────────────────────┐
│      AWS 側 VPC (10.0.0.0/16)   │        │    仮想オンプレ側 VPC (192.168.0.0/16)   │
│                                 │        │                                          │
│  ┌─────────────────────────┐    │        │  ┌──────────────────────────────┐        │
│  │  Private Isolated Subnet │    │        │  │  Public Subnet               │        │
│  │                         │    │        │  │                              │        │
│  │  ┌──────────┐  ┌──────┐ │    │        │  │  ┌──────────────────────┐   │        │
│  │  │ AWS EC2  │  │ EICE │ │    │        │  │  │ VPN EC2 (strongSwan) │   │        │
│  │  └──────────┘  └──────┘ │    │        │  │  │ EIP                  │   │        │
│  └─────────────────────────┘    │        │  └──────────────────────────────┘        │
│                                 │        │                                          │
│  ┌──────┐                       │        │  ┌──────────────────────────────┐        │
│  │ VGW  │◄──── S2S VPN ────────────────►│  │  Private Isolated Subnet     │        │
│  └──────┘                       │        │  │                              │        │
│                                 │        │  │  ┌────────────┐  ┌──────┐   │        │
└─────────────────────────────────┘        │  │  │ オンプレEC2 │  │ EICE │   │        │
                                           │  │  └────────────┘  └──────┘   │        │
                                           │  └──────────────────────────────┘        │
                                           └──────────────────────────────────────────┘
```

### スタック構成

| スタック | 主なリソース |
|---|---|
| `VpnPocAwsSideStack` | AWS 側 VPC・EC2・EICE |
| `VpnPocOnPremSideStack` | 仮想オンプレ側 VPC・VPN EC2（strongSwan）・疎通確認 EC2・EICE |
| `VpnPocStack` | VGW・Customer Gateway・S2S VPN Connection・EIP・ルートテーブル・SG ルール |

## 前提条件

- Node.js 18 以上
- AWS CDK v2
- AWS CLI（認証情報設定済み）

```bash
npm install -g aws-cdk
npm install
```

## 設定

`config/dev.ts` で環境ごとのパラメータを管理しています。

```typescript
export const devConfig = {
  envName: "dev",
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: "ap-northeast-1",
  awsVpcCidr: "10.0.0.0/16",
  onPremVpcCidr: "192.168.0.0/16",
  onPremPrivateSubnetCidr: "192.168.1.0/24",
  dummyTunnelOutsideIp1: "192.0.2.1/32",  // 後で実際の Outside IP に変更
  dummyTunnelOutsideIp2: "192.0.2.2/32",  // 後で実際の Outside IP に変更
  removalPolicy: cdk.RemovalPolicy.DESTROY,
};
```

## デプロイ手順

### 1. 1回目のデプロイ

```bash
npx cdk deploy --all -c stage=dev
```

> デプロイには約5〜6分かかります（EICE のプロビジョニングが主な要因）。

---

### 2. 1回目デプロイ後の確認

**CloudFormation**
- 3スタックすべてが `CREATE_COMPLETE` になっていること

**Tunnel Outside IP の確認（次のステップで使用）**

AWS Console → VPC → Site-to-Site VPN Connections → 対象接続 → **Tunnel details** タブ

- Tunnel 1 / Tunnel 2 の Outside IP を2つメモする
- Status は `DOWN` で正常（まだ strongSwan を設定していないため）

**EIP の確認**

EC2 → `vpn-poc-on-prem-side-vpn-ec2` の Public IPv4 に EIP が割り当てられており、Customer Gateway の IP と一致していること

**VPN EC2 の初期化確認**

EICE 経由で VPN EC2 に SSH してログを確認する。

```bash
aws ec2-instance-connect ssh \
  --instance-id <vpn-ec2-instance-id> \
  --region ap-northeast-1

# strongSwan のインストール確認
dpkg -l | grep strongswan

# IP forwarding の確認（1 であること）
sysctl net.ipv4.ip_forward

# cloud-init のエラー確認
tail -30 /var/log/cloud-init-output.log
```

---

### 3. Tunnel Outside IP の更新

`config/dev.ts` のダミー値を実際の Outside IP に書き換える。

```typescript
dummyTunnelOutsideIp1: "x.x.x.x/32",  // Tunnel 1 Outside IP
dummyTunnelOutsideIp2: "y.y.y.y/32",  // Tunnel 2 Outside IP
```

---

### 4. 2回目のデプロイ

```bash
npx cdk deploy --all -c stage=dev
```

VPN EC2 の SG inbound ルール（UDP 500 / UDP 4500）が実際の Outside IP に更新される。

---

### 5. VPN 設定ファイルのダウンロード

AWS Console → VPC → Site-to-Site VPN Connections → 対象接続を選択 → **Download configuration**

- Vendor: `Generic` または `Strongswan`

---

### 6. VPN EC2 への設定投入

EICE 経由で VPN EC2 に SSH する。

```bash
aws ec2-instance-connect ssh \
  --instance-id <vpn-ec2-instance-id> \
  --region ap-northeast-1
```

**`/etc/ipsec.conf` の編集**

```bash
sudo vi /etc/ipsec.conf
```

ダウンロードした設定ファイルの内容を貼り付ける。以下の点を確認する。

- `leftupdown` の `-r` パラメータが AWS 側 VPC CIDR（`10.0.0.0/16`）になっていること
- Tunnel 1 と Tunnel 2 の `-m`（mark）が異なる値になっていること

**`/etc/ipsec.secrets` の編集**

```bash
sudo vi /etc/ipsec.secrets
```

```
<EIP> <Tunnel1 Outside IP> : PSK "<psk1>"
<EIP> <Tunnel2 Outside IP> : PSK "<psk2>"
```

**`/etc/ipsec.d/aws-updown.sh` の作成**

```bash
sudo vi /etc/ipsec.d/aws-updown.sh
# ダウンロードした設定ファイル内の aws-updown.sh の内容を貼り付ける

sudo chmod +x /etc/ipsec.d/aws-updown.sh
```

**strongSwan の再起動**

```bash
sudo systemctl restart strongswan-starter
```

---

### 7. VPN トンネルの確認

**VPN EC2 上で確認**

```bash
sudo ipsec statusall
# ESTABLISHED と表示されること
```

**AWS Console で確認**

VPN Connections → Tunnel details → Status が `UP` に変わっていること

---

### 8. 疎通確認（ping）

**オンプレ側 EC2 → AWS 側 EC2**

```bash
aws ec2-instance-connect ssh \
  --instance-id <on-prem-ec2-instance-id> \
  --region ap-northeast-1

ping <aws-ec2-private-ip>
```

**AWS 側 EC2 → オンプレ側 EC2**

```bash
aws ec2-instance-connect ssh \
  --instance-id <aws-ec2-instance-id> \
  --region ap-northeast-1

ping <on-prem-ec2-private-ip>
```

双方から ping が通れば PoC 完了。

## CDK コマンド

```bash
npx cdk synth -c stage=dev   # CloudFormation テンプレートの生成
npx cdk diff -c stage=dev    # デプロイ済みスタックとの差分確認
npx cdk deploy --all -c stage=dev  # 全スタックのデプロイ
npx cdk destroy --all -c stage=dev # 全スタックの削除
```
