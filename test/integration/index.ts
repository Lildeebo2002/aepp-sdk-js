import {
  AeSdk, CompilerHttpNode, CompilerCli8, MemoryAccount, Node, Encoded, ConsensusProtocolVersion,
} from '../../src';
import '..';

export const url = process.env.TEST_URL ?? 'http://localhost:3013';
export const compilerUrl = process.env.COMPILER_URL ?? 'http://localhost:3080';
const secretKey = process.env.SECRET_KEY ?? '9ebd7beda0c79af72a42ece3821a56eff16359b6df376cf049aee995565f022f840c974b97164776454ba119d84edc4d6058a8dec92b6edc578ab2d30b4c4200';
export const networkId = process.env.TEST_NETWORK_ID ?? 'ae_devnet';
export const ignoreVersion = process.env.IGNORE_VERSION === 'true';
const genesisAccount = new MemoryAccount(secretKey);

type TransactionHandler = (tx: Encoded.Transaction) => unknown;
const transactionHandlers: TransactionHandler[] = [];

export function addTransactionHandler(cb: TransactionHandler): void {
  transactionHandlers.push(cb);
}

class NodeHandleTx extends Node {
  // @ts-expect-error use code generation to create node class?
  override async postTransaction(
    ...args: Parameters<Node['postTransaction']>
  ): ReturnType<Node['postTransaction']> {
    transactionHandlers.forEach((cb) => cb(args[0].tx as Encoded.Transaction));
    return super.postTransaction(...args);
  }
}

export async function getSdk(accountCount = 1): Promise<AeSdk> {
  const accounts = new Array(accountCount).fill(null).map(() => MemoryAccount.generate());
  const sdk = new AeSdk({
    onCompiler: new CompilerHttpNode(compilerUrl, { ignoreVersion }),
    nodes: [{ name: 'test', instance: new NodeHandleTx(url, { ignoreVersion }) }],
    accounts,
    _expectedMineRate: 1000,
    _microBlockCycle: 300,
  });
  // TODO: remove after release aesophia_http@8
  if ((await sdk.api.getNodeInfo()).consensusProtocolVersion === ConsensusProtocolVersion.Ceres) {
    sdk._options.onCompiler = new CompilerCli8();
  }
  for (let i = 0; i < accounts.length; i += 1) {
    await sdk.spend(1e32, accounts[i].address, { onAccount: genesisAccount });
  }
  return sdk;
}
