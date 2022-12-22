import BigNumber from 'bignumber.js';
import { hash, verify } from '../utils/crypto';
import {
  CtVersion,
  PROTOCOL_VM_ABI,
  RawTxObject,
  TxParamsCommon,
  TxSchema,
  TxTypeSchemas,
} from './builder/schema';
import { Tag } from './builder/constants';
import { TxUnpacked, unpackTx } from './builder';
import { UnsupportedProtocolError } from '../utils/errors';
import { concatBuffers, isAccountNotFoundError, isKeyOfObject } from '../utils/other';
import { encode, Encoded, Encoding } from '../utils/encoder';
import Node, { TransformNodeType } from '../Node';
import { Account } from '../apis/node';
import { genAggressiveCacheGetResponsesPolicy } from '../utils/autorest';

export interface ValidatorResult {
  message: string;
  key: string;
  checkedKeys: string[];
}

type Validator = (
  tx: {
    encodedTx: TxUnpacked<TxSchema>;
    signatures: Buffer[];
    tx: TxUnpacked<TxSchema> & {
      tx: TxTypeSchemas[Tag.SignedTx];
    };
    nonce?: number;
    ttl?: number;
    amount?: number;
    fee?: number;
    nameFee?: number;
    ctVersion?: Partial<CtVersion>;
    abiVersion?: number;
    contractId?: Encoded.ContractAddress;
  },
  options: {
    // TODO: remove after fixing node types
    account?: TransformNodeType<Account> & { id: Encoded.AccountAddress };
    nodeNetworkId: string;
    parentTxTypes: Tag[];
    node: Node;
    txType: Tag;
    height: number;
    consensusProtocolVersion: number;
  }
) => ValidatorResult[] | Promise<ValidatorResult[]>;

const validators: Validator[] = [];

const getSenderAddress = (
  tx: TxParamsCommon | RawTxObject<TxSchema>,
): Encoded.AccountAddress | undefined => [
  'senderId', 'accountId', 'ownerId', 'callerId',
  'oracleId', 'fromId', 'initiator', 'gaId', 'payerId',
]
  .map((key: keyof TxSchema) => tx[key])
  .filter((a) => a)
  .map((a) => a?.toString().replace(/^ok_/, 'ak_'))[0] as Encoded.AccountAddress | undefined;

/**
 * Transaction Validator
 * This function validates some of transaction properties,
 * to make sure it can be posted it to the chain
 * @category transaction builder
 * @param transaction - Base64Check-encoded transaction
 * @param nodeNotCached - Node to validate transaction against
 * @param parentTxTypes - Types of parent transactions
 * @returns Array with verification errors
 * @example const errors = await verifyTransaction(transaction, node)
 */
export default async function verifyTransaction(
  transaction: Encoded.Transaction | Encoded.Poi,
  nodeNotCached: Node,
  parentTxTypes: Tag[] = [],
): Promise<ValidatorResult[]> {
  let node = nodeNotCached;
  if (
    !node.pipeline.getOrderedPolicies()
      .some(({ name }) => name === 'aggressive-cache-get-responses')
  ) {
    node = new Node(nodeNotCached.$host, { ignoreVersion: true });
    node.pipeline.addPolicy(genAggressiveCacheGetResponsesPolicy());
  }

  const { tx, txType } = unpackTx<Tag.SignedTx>(transaction);
  const address = getSenderAddress(tx)
    ?? (txType === Tag.SignedTx ? getSenderAddress(tx.encodedTx.tx) : undefined);
  const [account, { height }, { consensusProtocolVersion, nodeNetworkId }] = await Promise.all([
    address == null
      ? undefined
      : node.getAccountByPubkey(address)
        .catch((error) => {
          if (!isAccountNotFoundError(error)) throw error;
          return { id: address, balance: 0n, nonce: 0 };
        })
        // TODO: remove after fixing https://github.com/aeternity/aepp-sdk-js/issues/1537
        .then((acc) => ({ ...acc, id: acc.id as Encoded.AccountAddress })),
    node.getCurrentKeyBlockHeight(),
    node.getNodeInfo(),
  ]);

  return (await Promise.all(
    validators.map((v) => v(
      tx as any,
      {
        txType, node, account, height, consensusProtocolVersion, nodeNetworkId, parentTxTypes,
      },
    )),
  )).flat();
}

validators.push(
  ({ encodedTx, signatures }, { account, nodeNetworkId, parentTxTypes }) => {
    if ((encodedTx ?? signatures) == null) return [];
    if (account == null) return [];
    if (signatures.length !== 1) return []; // TODO: Support multisignature?
    const prefix = Buffer.from([
      nodeNetworkId,
      ...parentTxTypes.includes(Tag.PayingForTx) ? ['inner_tx'] : [],
    ].join('-'));
    const txWithNetworkId = concatBuffers([prefix, encodedTx.rlpEncoded]);
    const txHashWithNetworkId = concatBuffers([prefix, hash(encodedTx.rlpEncoded)]);
    if (verify(txWithNetworkId, signatures[0], account.id)
      || verify(txHashWithNetworkId, signatures[0], account.id)) return [];
    return [{
      message: 'Signature cannot be verified, please ensure that you transaction have'
        + ' the correct prefix and the correct private key for the sender address',
      key: 'InvalidSignature',
      checkedKeys: ['encodedTx', 'signatures'],
    }];
  },
  async ({ encodedTx, tx }, { node, parentTxTypes, txType }) => {
    if ((encodedTx ?? tx) == null) return [];
    return verifyTransaction(
      encode((encodedTx ?? tx).rlpEncoded, Encoding.Transaction),
      node,
      [...parentTxTypes, txType],
    );
  },
  ({ ttl }, { height }) => {
    if (ttl == null) return [];
    ttl = +ttl;
    if (ttl === 0 || ttl >= height) return [];
    return [{
      message: `TTL ${ttl} is already expired, current height is ${height}`,
      key: 'ExpiredTTL',
      checkedKeys: ['ttl'],
    }];
  },
  ({
    amount, fee, nameFee, tx,
  }, { account, parentTxTypes, txType }) => {
    if (account == null) return [];
    if ((amount ?? fee ?? nameFee) == null) return [];
    fee ??= 0;
    const cost = new BigNumber(fee).plus(nameFee ?? 0).plus(amount ?? 0)
      .plus(txType === Tag.PayingForTx ? (tx.tx.encodedTx.tx).fee : 0)
      .minus(parentTxTypes.includes(Tag.PayingForTx) ? fee : 0);
    if (cost.lte(account.balance.toString())) return [];
    return [{
      message: `Account balance ${account.balance.toString()} is not enough to execute the transaction that costs ${cost.toFixed()}`,
      key: 'InsufficientBalance',
      checkedKeys: ['amount', 'fee', 'nameFee'],
    }];
  },
  ({ signatures }, { account, txType }) => {
    if (account == null) return [];
    let message;
    if (txType === Tag.SignedTx && account.kind === 'generalized' && signatures.length !== 0) {
      message = 'Generalized account can\'t be used to generate SignedTx with signatures';
    }
    if (txType === Tag.GaMetaTx && account.kind === 'basic') {
      message = 'Basic account can\'t be used to generate GaMetaTx';
    }
    if (message == null) return [];
    return [{ message, key: 'InvalidAccountType', checkedKeys: ['tag'] }];
  },
  ({ nonce }, { account, parentTxTypes }) => {
    if (nonce == null || account == null || parentTxTypes.includes(Tag.GaMetaTx)) return [];
    nonce = +nonce;
    const validNonce = account.nonce + 1;
    if (nonce === validNonce) return [];
    return [{
      ...nonce < validNonce
        ? {
          message: `Nonce ${nonce} is already used, valid nonce is ${validNonce}`,
          key: 'NonceAlreadyUsed',
        }
        : {
          message: `Nonce ${nonce} is too high, valid nonce is ${validNonce}`,
          key: 'NonceHigh',
        },
      checkedKeys: ['nonce'],
    }];
  },
  ({ ctVersion, abiVersion }, { txType, consensusProtocolVersion }) => {
    if (!isKeyOfObject(consensusProtocolVersion, PROTOCOL_VM_ABI)) {
      throw new UnsupportedProtocolError(`Unsupported protocol: ${consensusProtocolVersion}`);
    }
    const protocol = PROTOCOL_VM_ABI[consensusProtocolVersion];

    // If not contract create tx
    if (ctVersion == null) ctVersion = { abiVersion };
    const txProtocol = protocol[txType as keyof typeof protocol];
    if (txProtocol == null) return [];
    if (Object.entries(ctVersion).some(
      ([
        key,
        value,
      ]: [
        key:keyof typeof txProtocol,
        value:any]) => !(txProtocol[key].includes(+value as never)),
    )) {
      return [{
        message: `ABI/VM version ${JSON.stringify(ctVersion)} is wrong, supported is: ${JSON.stringify(txProtocol)}`,
        key: 'VmAndAbiVersionMismatch',
        checkedKeys: ['ctVersion', 'abiVersion'],
      }];
    }
    return [];
  },
  async ({ contractId }, { txType, node }) => {
    if (Tag.ContractCallTx !== txType) return [];
    contractId = contractId as Encoded.ContractAddress;
    try {
      const { active } = await node.getContract(contractId);
      if (active) return [];
      return [{
        message: `Contract ${contractId} is not active`,
        key: 'ContractNotActive',
        checkedKeys: ['contractId'],
      }];
    } catch (error) {
      if (error.response?.parsedBody?.reason == null) throw error;
      return [{
        message: error.response.parsedBody.reason,
        key: 'ContractNotFound',
        checkedKeys: ['contractId'],
      }];
    }
  },
);
