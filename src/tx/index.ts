/*
 * ISC License (ISC)
 * Copyright (c) 2022 aeternity developers
 *
 *  Permission to use, copy, modify, and/or distribute this software for any
 *  purpose with or without fee is hereby granted, provided that the above
 *  copyright notice and this permission notice appear in all copies.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 *  REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 *  AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 *  INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 *  LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 *  OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 *  PERFORMANCE OF THIS SOFTWARE.
 */

/**
 * Transaction methods
 *
 * This is implementation of [Tx](api/tx.md) relays
 * the creation of transactions to {@link Node}.
 * These methods provide ability to create native transactions.
 */
import { TxParamsCommon } from './builder/schema';
import { ConsensusProtocolVersion, Tag } from './builder/constants';
import { ArgumentError, InvalidTxParamsError } from '../utils/errors';
import Node from '../Node';
import { Encoded } from '../utils/encoder';
import { buildTx as syncBuildTx, unpackTx } from './builder/index';
import { isAccountNotFoundError } from '../utils/other';

export type BuildTxOptions <TxType extends Tag, OmitFields extends string> =
  Omit<Parameters<typeof _buildTx<TxType>>[1], OmitFields>;

// TODO: find a better name or rearrange methods
/**
 * @category transaction builder
 */
export async function _buildTx<TxType extends Tag>(
  txType: TxType,
  { strategy, onNode, ..._params }: Omit<Parameters<typeof syncBuildTx<TxType>>[0], 'tag' | 'nonce'>
  & {
    strategy?: 'continuity' | 'max';
    onNode: Node;
    nonce?: number;
  }
  & (TxType extends Tag.OracleExtendTx | Tag.OracleResponseTx
    ? { callerId: Encoded.AccountAddress } : {}),
): Promise<Encoded.Transaction> {
  // TODO: avoid this assertion
  const params = _params as unknown as TxParamsCommon & { onNode: Node };
  let senderKey: keyof TxParamsCommon | '<absent>';
  switch (txType) {
    case Tag.SpendTx:
    case Tag.OracleQueryTx:
      senderKey = 'senderId';
      break;
    case Tag.NameClaimTx:
    case Tag.NameUpdateTx:
    case Tag.NameRevokeTx:
    case Tag.NameTransferTx:
    case Tag.NamePreclaimTx:
    case Tag.OracleRegisterTx:
      senderKey = 'accountId';
      break;
    case Tag.ContractCreateTx:
    case Tag.GaAttachTx:
      senderKey = 'ownerId';
      break;
    case Tag.GaMetaTx:
      senderKey = 'gaId';
      break;
    case Tag.ContractCallTx:
    case Tag.OracleExtendTx:
    case Tag.OracleResponseTx:
      senderKey = 'callerId';
      break;
    case Tag.ChannelCloseSoloTx:
    case Tag.ChannelSlashTx:
    case Tag.ChannelSettleTx:
    case Tag.ChannelSnapshotSoloTx:
      senderKey = 'fromId';
      break;
    case Tag.PayingForTx:
      senderKey = 'payerId';
      break;
    default:
      throw new ArgumentError('txType', 'valid transaction type', txType);
  }

  if (
    Object.keys(ConsensusProtocolVersion).length !== 2
    && (((Tag.ContractCreateTx === txType || Tag.GaAttachTx === txType) && params.ctVersion == null)
    || ((Tag.ContractCallTx === txType || Tag.GaMetaTx === txType) && params.abiVersion == null))
  ) {
    const { consensusProtocolVersion } = await onNode.getNodeInfo();
    params.consensusProtocolVersion = consensusProtocolVersion;
  }

  if (txType === Tag.PayingForTx) {
    params.tx = unpackTx(params.tx);
  }
  const senderId = params[senderKey];
  // TODO: do this check on TypeScript level
  if (senderId == null) throw new InvalidTxParamsError(`Transaction field ${senderKey} is missed`);

  params.nonce ??= (
    await onNode.getAccountNextNonce(senderId, { strategy }).catch((error) => {
      if (!isAccountNotFoundError(error)) throw error;
      return { nextNonce: 1 };
    })
  ).nextNonce;

  if (params.absoluteTtl !== true && params.ttl !== 0 && params.ttl !== undefined) {
    params.ttl += (await onNode.getCurrentKeyBlock()).height;
    params.absoluteTtl = true;
  }

  return syncBuildTx({ ...params, tag: txType } as any);
}
