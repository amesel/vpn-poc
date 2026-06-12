import * as cdk from "aws-cdk-lib";

export type EnvName = "dev" | "stg" | "prod";

export type AppConfig = {
  envName: EnvName;
  account: string | undefined;
  region: string;
  awsVpcCidr: string;
  onPremVpcCidr: string;
  onPremPrivateSubnetCidr: string,
  dummyTunnelOutsideIp1: string,
  dummyTunnelOutsideIp2: string,
  removalPolicy: cdk.RemovalPolicy;
};
