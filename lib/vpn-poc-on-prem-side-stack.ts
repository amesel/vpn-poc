import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { AppConfig } from "../config/types";
import * as ec2 from 'aws-cdk-lib/aws-ec2';

type VpnPocOnPremSideStackProps = cdk.StackProps & {
  config: AppConfig;
};

export class VpnPocOnPremSideStack extends cdk.Stack {
  public readonly onPremSideVpc: ec2.Vpc;
  public readonly onPremSideEc2Sg: ec2.SecurityGroup;
  public readonly onPremSideVpnEc2Sg: ec2.SecurityGroup;
  public readonly onPremSideVpnEc2: ec2.Instance;

  constructor(scope: Construct, id: string, props: VpnPocOnPremSideStackProps) {
    super(scope, id, props);

    const { config } = props;

    /**
     * 仮想オンプレ側 VPC
     * - 1AZ
     * - NAT Gateway なし
     *
     * Public subnet は VPN 用 EC2 の Internet 通信用。
     * Private subnet は疎通確認用 EC2 と EICE 用。
     */
    this.onPremSideVpc = new ec2.Vpc(this, 'OnPremSideVpc', {
      vpcName: 'vpn-poc-on-prem-side-vpc',
      ipAddresses: ec2.IpAddresses.cidr(config.onPremVpcCidr),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'vpn-poc-on-prem-side-public-subnet',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'vpn-poc-on-prem-side-private-subnet',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    /**
     * EICE 用 Security Group
     * - inbound は不要
     * - outbound は後で EC2 2台への SSH のみ許可
     */
    const onPremSideEiceSg = new ec2.SecurityGroup(
      this,
      'OnPremSideEiceSg',
      {
        vpc: this.onPremSideVpc,
        securityGroupName: 'on-prem-side-eice-sg',
        description: 'Security group for On-prem-side EICE',
        allowAllOutbound: false,
      },
    );

    /**
     * 疎通確認用 EC2 の Security Group
     */
    this.onPremSideEc2Sg = new ec2.SecurityGroup(
      this,
      'OnPremSideEc2Sg',
      {
        vpc: this.onPremSideVpc,
        securityGroupName: 'vpn-poc-on-prem-side-ec2-sg',
        description: 'Security group for On-prem-side connectivity EC2',
        allowAllOutbound: true,
      },
    );

    /**
     * VPN 用 EC2 の Security Group
     *
     * この段階では EICE 経由の SSH のみ inbound 許可。
     * 後で S2S VPN を構築する際に、
     * AWS VPN Endpoint からの UDP/500、UDP/4500、ESP 等を追加する。
     */
    this.onPremSideVpnEc2Sg = new ec2.SecurityGroup(
      this,
      'OnPremSideVpnEc2Sg',
      {
        vpc: this.onPremSideVpc,
        securityGroupName: 'vpn-poc-on-prem-side-vpn-ec2-sg',
        description: 'Security group for On-prem-side VPN EC2',
        allowAllOutbound: true,
      },
    );

    /**
     * EICE → EC2 への SSH のみ許可
     */
    onPremSideEiceSg.addEgressRule(
      this.onPremSideEc2Sg,
      ec2.Port.tcp(22),
      'Allow SSH to On-prem-side EC2',
    );

    onPremSideEiceSg.addEgressRule(
      this.onPremSideVpnEc2Sg,
      ec2.Port.tcp(22),
      'Allow SSH to On-prem-side VPN EC2',
    );

    this.onPremSideEc2Sg.addIngressRule(
      onPremSideEiceSg,
      ec2.Port.tcp(22),
      'Allow SSH only from On-prem-side EICE',
    );

    this.onPremSideVpnEc2Sg.addIngressRule(
      onPremSideEiceSg,
      ec2.Port.tcp(22),
      'Allow SSH only from On-prem-side EICE',
    );

    /**
     * EC2 Instance Connect Endpoint
     *
     * Private subnet に1つ作成し、
     * Public subnet / Private subnet の両 EC2 に Private IP で接続する。
     */
    const onPremSideEice = new ec2.CfnInstanceConnectEndpoint(
      this,
      'OnPremSideEice',
      {
        subnetId: this.onPremSideVpc.isolatedSubnets[0].subnetId,
        securityGroupIds: [onPremSideEiceSg.securityGroupId],
        preserveClientIp: false,
        tags: [
          {
            key: 'Name',
            value: 'vpn-poc-on-prem-side-eice',
          },
        ],
      },
    );

    /**
     * 疎通確認用 EC2
     * - Private subnet
     * - Amazon Linux 2023
     * - t3.micro
     * - EICE 経由でログイン
     */
    const onPremSideEc2 = new ec2.Instance(this, 'OnPremSideEc2', {
      vpc: this.onPremSideVpc,
      instanceName: 'vpn-poc-on-prem-side-ec2',
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: this.onPremSideEc2Sg,
    });
    
    /**
     * VPN 用 EC2
     * - Public subnet
     * - Ubuntu 24.04 LTS
     * - t3.micro
     * - EICE 経由でログイン
     */
    this.onPremSideVpnEc2 = new ec2.Instance(this, 'OnPremSideVpnEc2', {
      vpc: this.onPremSideVpc,
      instanceName: 'vpn-poc-on-prem-side-vpn-ec2',
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },

      /**
       * userData で apt install を行うため、初回起動時点で
       * インターネットへ出られるよう Public IP を付ける。
       * 後で EIP が関連付けられると、Customer Gateway 用の固定IPになる。
       */
      associatePublicIpAddress: true,

      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
      ),
      securityGroup: this.onPremSideVpnEc2Sg,

      /**
       * userData を変更した場合、検証用 VPN EC2 は作り直して
       * 初回起動処理を再実行する。
       */
      userDataCausesReplacement: true,
    });

    /**
     * strongSwan のインストールと、ルーターとしての OS 設定
     */
    this.onPremSideVpnEc2.userData.addCommands(
      'set -euxo pipefail',
      'apt-get update -y',
      'DEBIAN_FRONTEND=noninteractive apt-get install -y strongswan',

      // Private EC2 の通信を VPN へ中継するため IP forwarding を有効化
      "cat <<'EOF' > /etc/sysctl.d/99-vpn-router.conf",
      'net.ipv4.ip_forward=1',
      'EOF',
      'sysctl --system',

      // strongSwan はインストールのみ。接続設定は後で手動投入
      'systemctl enable strongswan-starter',
    );

    /**
     * EC2 をルーターとして使用するため、
     * Source/Destination Check を無効化
     */
    const onPremSideVpnCfnEc2 =
      this.onPremSideVpnEc2.node.defaultChild as ec2.CfnInstance;

    onPremSideVpnCfnEc2.sourceDestCheck = false;

  }
}
