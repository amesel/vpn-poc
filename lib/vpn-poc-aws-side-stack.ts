import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { AppConfig } from "../config/types";

type VpnPocAwsSideStackProps = cdk.StackProps & {
	config: AppConfig;
};

export class VpnPocAwsSideStack extends cdk.Stack {
	public readonly awsSideVpc: ec2.Vpc;
	public readonly awsSideEc2Sg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: VpnPocAwsSideStackProps) {
    super(scope, id, props);

    const { config } = props;

		/**
		 * AWS側 VPC
		 * - 1AZ
		 * - IGW / NAT Gateway なし
		 */
		this.awsSideVpc = new ec2.Vpc(this, 'AwsSideVpc', {
			vpcName: 'vpn-poc-aws-side-vpc',
			ipAddresses: ec2.IpAddresses.cidr(config.awsVpcCidr),
			maxAzs: 1,
			natGateways: 0,
			subnetConfiguration: [
				{
					name: 'vpn-poc-aws-side-private-subnet',
					subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
					cidrMask: 24,
				},
			],
		});

		/**
		 * EICE 用 Security Group
     * - outbound は後で EC2 への SSH のみ許可
		 */
		const awsSideEiceSg = new ec2.SecurityGroup(this, 'AwsSideEiceSg', {
			vpc: this.awsSideVpc,
			securityGroupName: 'vpn-poc-aws-side-eice-sg',
			description: 'Security group for AWS-side EICE',
			allowAllOutbound: false,
		});

		/**
		 * AWS側 EC2 用 Security Group
		 */
		this.awsSideEc2Sg = new ec2.SecurityGroup(this, 'AwsSideEc2Sg', {
			vpc: this.awsSideVpc,
			securityGroupName: 'vpn-poc-aws-side-ec2-sg',
			description: 'Security group for AWS-side EC2',
			allowAllOutbound: true,
		});

		// EICE → EC2 への SSH のみ許可
		awsSideEiceSg.addEgressRule(
			this.awsSideEc2Sg,
			ec2.Port.tcp(22),
			'Allow SSH to AWS-side EC2',
		)

		this.awsSideEc2Sg.addIngressRule(
			awsSideEiceSg,
			ec2.Port.tcp(22),
			'Allow SSH only from AWS-side EICE',
		);

		/**
		 * EC2 Instance Connect Endpoint
		 */
		const awsSideEice = new ec2.CfnInstanceConnectEndpoint(
			this,
			'AwsSideEice',
			{
				subnetId: this.awsSideVpc.isolatedSubnets[0].subnetId,
				securityGroupIds: [awsSideEiceSg.securityGroupId],
				preserveClientIp: false,
				tags: [
					{
						key: 'Name',
						value: 'vpn-poc-aws-side-eice',
					},
				],
			},
		);

		/**
		 * AWS側 EC2
		 * - Amazon Linux 2023 最新AMI
		 * - t3.micro
		 * - EICE から SSH 接続
		 */
		const awsSideEc2 = new ec2.Instance(this, 'AwsSideEc2', {
			vpc: this.awsSideVpc,
			instanceName: 'vpn-poc-aws-side-ec2',
			vpcSubnets: {
				subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
			},
			instanceType: ec2.InstanceType.of(
				ec2.InstanceClass.T3,
				ec2.InstanceSize.MICRO,
			),
			machineImage: ec2.MachineImage.latestAmazonLinux2023(),
			securityGroup: this.awsSideEc2Sg,
		});

	}
}
