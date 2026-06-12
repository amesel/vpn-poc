import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { AppConfig } from "../config/types";
import * as ec2 from 'aws-cdk-lib/aws-ec2';

type VpnPocStackProps = cdk.StackProps & {
  config: AppConfig;
  awsSideVpc: ec2.Vpc;
  awsSideEc2Sg: ec2.SecurityGroup;
  onPremSideVpc: ec2.Vpc;
  onPremSideEc2Sg: ec2.SecurityGroup;
  onPremSideVpnEc2Sg: ec2.SecurityGroup;
  onPremSideVpnEc2: ec2.Instance;
};

export class VpnPocStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VpnPocStackProps) {
    super(scope, id, props);

    const { config } = props;

    /**
     * 初回デプロイ時はダミー値。
     * VPN Connection 作成後、Tunnel details の Outside IP に置き換える。
     *
     * 192.0.2.0/24 はドキュメント例示用のアドレス範囲。
     */
    const awsVpnTunnelOutsideIps = [
      config.dummyTunnelOutsideIp1, // 後で Tunnel 1 Outside IP に変更
      config.dummyTunnelOutsideIp2, // 後で Tunnel 2 Outside IP に変更
    ];

    for (const awsVpnTunnelOutsideIp of awsVpnTunnelOutsideIps) {
      props.onPremSideVpnEc2Sg.addIngressRule(
        ec2.Peer.ipv4(awsVpnTunnelOutsideIp),
        ec2.Port.udp(500),
        'Allow IKE from AWS VPN tunnel endpoint',
      );
      props.onPremSideVpnEc2Sg.addIngressRule(
        ec2.Peer.ipv4(awsVpnTunnelOutsideIp),
        ec2.Port.udp(4500),
        'Allow NAT-T from AWS VPN tunnel endpoint',
      );
      // UDP4500でカプセル化するため必要なし
      // onPremSideVpnEc2Sg.addIngressRule(
      //   ec2.Peer.ipv4(awsVpnTunnelOutsideIp),
      //   ec2.Port.esp(),
      //   'Allow ESP from AWS VPN tunnel endpoint',
      // );
    }

    /**
     * OnPremSideEc2 のある Private subnet から
     * AWS側 VPC 宛の通信を VPN EC2 に送る
     */
    const onPremSideToAwsRoute = new ec2.CfnRoute(
      this,
      'OnPremSideToAwsRoute',
      {
        routeTableId: props.onPremSideVpc.isolatedSubnets[0].routeTable.routeTableId,
        destinationCidrBlock: config.awsVpcCidr,
        instanceId: props.onPremSideVpnEc2.instanceId,
      },
    );

    /**
     * 仮想オンプレ側の疎通確認サーバーから、
     * AWS側 EC2 への ping を許可
     */
    props.awsSideEc2Sg.addIngressRule(
      ec2.Peer.ipv4(config.onPremPrivateSubnetCidr),
      ec2.Port.allIcmp(),
      'Allow ICMP from On-prem-side private subnet',
    );

    props.onPremSideVpnEc2Sg.addIngressRule(
      ec2.Peer.ipv4(config.onPremPrivateSubnetCidr),
      ec2.Port.allIcmp(),
      'Allow ICMP from on-prem private subnet for VPN routing',
    );

    /**
     * AWS側 EC2の疎通確認サーバーから、
     * オンプレ側 EC2 への ping を許可
     */
    props.onPremSideEc2Sg.addIngressRule(
      ec2.Peer.ipv4(config.awsVpcCidr),
      ec2.Port.allIcmp(),
      'Allow ICMP from AWS-side VPC',
    );

    /**
     * AWS側 Virtual Private Gateway
     */
    const awsSideVgw = new ec2.CfnVPNGateway(this, 'AwsSideVgw', {
      type: 'ipsec.1',
      tags: [
        {
          key: 'Name',
          value: 'aws-side-vgw',
        },
      ],
    });

    /**
     * VGW を AWS側 VPC にアタッチ
     */
    const awsSideVgwAttachment = new ec2.CfnVPCGatewayAttachment(
      this,
      'AwsSideVgwAttachment',
      {
        vpcId: props.awsSideVpc.vpcId,
        vpnGatewayId: awsSideVgw.ref,
      },
    );

    /**
     * VPN 用 EC2 に固定 Public IP を付与
     *
     * この段階では VPN 設定には使わないが、
     * 後で Customer Gateway に登録する IP として利用する。
     */
    const onPremSideVpnEc2Eip = new ec2.CfnEIP(
      this,
      'OnPremSideVpnEc2Eip',
      {
        domain: 'vpc',
        tags: [
          {
            key: 'Name',
            value: 'vpn-poc-on-prem-side-vpn-ec2-eip',
          },
        ],
      },
    );

    /**
     * Customer Gateway
     * - OnPremSideVpnEc2 の Elastic IP を登録
     * - 今回は static route を使うため BGP は実運用しないが、
     *   Customer Gateway 作成上 ASN を指定する
     */
    const onPremSideCgw = new ec2.CfnCustomerGateway(
      this,
      'OnPremSideCustomerGateway',
      {
        type: 'ipsec.1',
        bgpAsn: 65000,
        ipAddress: onPremSideVpnEc2Eip.ref,
        tags: [
          {
            key: 'Name',
            value: 'on-prem-side-cgw',
          },
        ],
      },
    );

    /**
     * Site-to-Site VPN Connection
     * - Static Route 構成
     * - Tunnel Endpoint / PSK 等は作成後に設定ファイルから取得
     */
    const siteToSiteVpnConnection = new ec2.CfnVPNConnection(
      this,
      'SiteToSiteVpnConnection',
      {
        type: 'ipsec.1',
        customerGatewayId: onPremSideCgw.ref,
        vpnGatewayId: awsSideVgw.ref,
        staticRoutesOnly: true,

        // Customer Gateway 側ネットワーク
        localIpv4NetworkCidr: config.onPremVpcCidr,

        // AWS側ネットワーク
        remoteIpv4NetworkCidr: config.awsVpcCidr,

        tags: [
          {
            key: 'Name',
            value: 'site-to-site-vpn-connection',
          },
        ],
      },
    );

    /**
     * VPN Connection が到達可能なオンプレ側 CIDR
     */
    new ec2.CfnVPNConnectionRoute(this, 'VpnRouteToOnPremSide', {
      vpnConnectionId: siteToSiteVpnConnection.ref,
      destinationCidrBlock: config.onPremVpcCidr,
    });

    /**
     * AWS側 EC2 のある Private subnet から、
     * 仮想オンプレ側 VPC 宛の通信を VGW に送る
     */
    const awsSideToOnPremRoute = new ec2.CfnRoute(
      this,
      'AwsSideToOnPremRoute',
      {
        routeTableId: props.awsSideVpc.isolatedSubnets[0].routeTable.routeTableId,
        destinationCidrBlock: config.onPremVpcCidr,
        gatewayId: awsSideVgw.ref,
      },
    );

    awsSideToOnPremRoute.addDependency(awsSideVgwAttachment);

    new ec2.CfnEIPAssociation(this, 'OnPremSideVpnEc2EipAssociation', {
      allocationId: onPremSideVpnEc2Eip.attrAllocationId,
      instanceId: props.onPremSideVpnEc2.instanceId,
    });

  }
}
