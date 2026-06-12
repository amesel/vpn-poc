#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { VpnPocAwsSideStack } from '../lib/vpn-poc-aws-side-stack';
import { VpnPocOnPremSideStack } from '../lib/vpn-poc-on-prem-side-stack';
import { VpnPocStack } from '../lib/vpn-poc-stack';
import { configs, Stage } from "../config";

const app = new cdk.App();

const stage = app.node.tryGetContext("stage") as Stage;

if (!stage || !(stage in configs)) {
  throw new Error("stage must be one of: dev, stg, prod");
}

const config = configs[stage];

const awsSideStack = new VpnPocAwsSideStack(app, `vpn-poc-aws-side-${config.envName}`, {
  env: {
    account: config.account,
    region: config.region,
  },
  config,
});

const onPremSideStack = new VpnPocOnPremSideStack(app, `vpn-poc-on-prem-side-${config.envName}`, {
  env: {
    account: config.account,
    region: config.region,
  },
  config,
});

new VpnPocStack(app, `vpn-poc-${config.envName}`, {
  env: {
    account: config.account,
    region: config.region,
  },
  config,
  awsSideVpc: awsSideStack.awsSideVpc,
  awsSideEc2Sg: awsSideStack.awsSideEc2Sg,
  onPremSideVpc: onPremSideStack.onPremSideVpc,
  onPremSideEc2Sg: onPremSideStack.onPremSideEc2Sg,
  onPremSideVpnEc2Sg: onPremSideStack.onPremSideVpnEc2Sg,
  onPremSideVpnEc2: onPremSideStack.onPremSideVpnEc2,
});
