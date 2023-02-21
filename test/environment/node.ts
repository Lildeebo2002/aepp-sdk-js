#!/usr/bin/env ts-node
import {
  Node, AeSdk, MemoryAccount, CompilerHttp,
} from '../..';

const contractSourceCode = `
contract Test =
 entrypoint getArg(x : map(string, int)) = x
`;
const node = new Node('https://testnet.aeternity.io');
const aeSdk = new AeSdk({
  nodes: [{ name: 'testnet', instance: node }],
  accounts: [
    new MemoryAccount('9ebd7beda0c79af72a42ece3821a56eff16359b6df376cf049aee995565f022f840c974b97164776454ba119d84edc4d6058a8dec92b6edc578ab2d30b4c4200'),
  ],
  onCompiler: new CompilerHttp('https://v7.compiler.stg.aepps.com'),
});

(async () => {
  console.log('Height:', await aeSdk.getHeight());
  console.log('Instanceof works correctly for nodes pool', aeSdk.pool instanceof Map);

  const contract = await aeSdk.initializeContract({ sourceCode: contractSourceCode });
  const deployInfo = await contract.$deploy([]);
  console.log('Contract deployed at', deployInfo.address);
  const map = new Map([['foo', 42], ['bar', 43]]);
  const { decodedResult } = await contract.getArg(map);
  console.log('Call result', decodedResult);
  console.log('Instanceof works correctly for returned map', decodedResult instanceof Map);
})();
