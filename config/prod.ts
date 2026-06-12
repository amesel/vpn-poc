import * as cdk from "aws-cdk-lib";
import { AppConfig } from "./types";

export const prodConfig = {
  envName: "prod",
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: "ap-northeast-1",
  awsVpcCidr: "10.0.0.0/16",
  onPremVpcCidr: "192.168.0.0/16",
  onPremPrivateSubnetCidr: "192.168.1.0/24",
  dummyTunnelOutsideIp1: "192.0.2.1/32",
  dummyTunnelOutsideIp2: "192.0.2.2/32",
  removalPolicy: cdk.RemovalPolicy.DESTROY,
} satisfies AppConfig;
