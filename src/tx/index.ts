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
 * the creation of transactions to {@link module:@aeternity/aepp-sdk/es/Node}.
 * These methods provide ability to create native transaction's,
 * or transaction's using Node API.
 * As there is no built-in security between Node and client communication,
 * creating transaction using {@link module:@aeternity/aepp-sdk/es/Node} API
 * must never be used for production but can be very useful to verify other
 * implementations.
 */
import {
  ABI_VERSIONS, CtVersion, PROTOCOL_VM_ABI, TX_TYPE, TX_TTL, TxParamsCommon, TxTypeSchemas
} from './builder/schema'
import {
  ArgumentError, UnsupportedProtocolError, UnknownTxError, InvalidTxParamsError
} from '../utils/errors'
import { BigNumber } from 'bignumber.js'
import Node from '../node'
import { EncodedData } from '../utils/encoder'
import { buildTx as syncBuildTx, calculateFee, unpackTx } from './builder/index'
import { isKeyOfObject } from '../utils/other'
import AccountBase from '../account/base'

// uses a new feature, probably typescript-eslint doesn't support it yet
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type BuildTxOptions <TxType extends TX_TYPE, OmitFields extends string> =
  Omit<Parameters<typeof _buildTx<TxType>>[1], OmitFields>

// TODO: find a better name or rearrange methods
export async function _buildTx<TxType extends TX_TYPE> (
  txType: TxType,
  { onAccount, ..._params }: TxTypeSchemas[TxType] & { onNode: Node, onAccount: AccountBase }
): Promise<EncodedData<'tx'>> {
  // TODO: avoid this assertion
  const params = _params as unknown as TxParamsCommon & { onNode: Node }
  let senderKey: keyof TxParamsCommon | '<absent>'
  switch (txType) {
    case TX_TYPE.spend:
    case TX_TYPE.oracleQuery:
      senderKey = 'senderId'
      break
    case TX_TYPE.nameClaim:
    case TX_TYPE.nameUpdate:
    case TX_TYPE.nameRevoke:
    case TX_TYPE.nameTransfer:
    case TX_TYPE.namePreClaim:
    case TX_TYPE.oracleRegister:
      senderKey = 'accountId'
      break
    case TX_TYPE.contractCreate:
    case TX_TYPE.gaAttach:
      senderKey = 'ownerId'
      break
    case TX_TYPE.contractCall:
      senderKey = 'callerId'
      break
    case TX_TYPE.oracleExtend:
    case TX_TYPE.oracleResponse:
      senderKey = '<absent>'
      break
    case TX_TYPE.channelCloseSolo:
    case TX_TYPE.channelSlash:
    case TX_TYPE.channelSettle:
    case TX_TYPE.channelSnapshotSolo:
      senderKey = 'fromId'
      break
    case TX_TYPE.payingFor:
      senderKey = 'payerId'
      break
    default:
      throw new ArgumentError('txType', 'valid transaction type', txType)
  }
  // TODO: move specific cases to field-types
  if ([TX_TYPE.contractCreate, TX_TYPE.gaAttach].includes(txType)) {
    params.ctVersion = await getVmVersion(
      TX_TYPE.contractCreate, { ...params, ...params.ctVersion }
    )
  }
  if (txType === TX_TYPE.contractCall) {
    params.abiVersion = (await getVmVersion(TX_TYPE.contractCall, params)).abiVersion
  }
  if (txType === TX_TYPE.oracleRegister) {
    params.abiVersion ??= ABI_VERSIONS.NO_ABI
  }
  if (txType === TX_TYPE.payingFor) {
    params.tx = unpackTx(params.tx)
  }
  const senderId = senderKey === '<absent>' ? await onAccount.address() : params[senderKey]
  // TODO: do this check on TypeScript level
  if (senderId == null) throw new InvalidTxParamsError(`Transaction field ${senderKey} is missed`)
  const extraParams = await prepareTxParams(txType, { ...params, senderId })
  return syncBuildTx({ ...params, ...extraParams }, txType).tx
}

/**
 * Validated vm/abi version or get default based on transaction type and NODE version
 *
 * @param txType Type of transaction
 * @param ctVersion Object with vm and abi version fields
 * @param options
 * @returns Object with vm/abi version
 */
export async function getVmVersion (
  txType: TX_TYPE.contractCreate, ctVersion: Partial<CtVersion> & { onNode: Node }
): Promise<CtVersion>
export async function getVmVersion (
  txType: TX_TYPE, ctVersion: Partial<Pick<CtVersion, 'abiVersion'>> & { onNode: Node }
): Promise<Pick<CtVersion, 'abiVersion'>>
export async function getVmVersion (
  txType: TX_TYPE, { vmVersion, abiVersion, onNode }: Partial<CtVersion> & { onNode: Node }
): Promise<Partial<CtVersion>> {
  const { consensusProtocolVersion } = await onNode.getNodeInfo()
  if (!isKeyOfObject(consensusProtocolVersion, PROTOCOL_VM_ABI)) {
    throw new UnsupportedProtocolError('Not supported consensus protocol version')
  }
  const supportedProtocol = PROTOCOL_VM_ABI[consensusProtocolVersion]
  if (!isKeyOfObject(txType, supportedProtocol)) {
    throw new UnknownTxError('Not supported tx type')
  }
  const protocolForTX = supportedProtocol[txType]
  abiVersion ??= protocolForTX.abiVersion[0]
  vmVersion ??= protocolForTX.vmVersion[0]
  return { vmVersion, abiVersion }
}

/**
 * Compute the absolute ttl by adding the ttl to the current height of the chain
 *
 * @param ttl
 * @param relative ttl is absolute or relative(default: true(relative))
 * @returns Absolute Ttl
 */
export async function calculateTtl (
  { ttl = TX_TTL, relative = true, onNode }:
  { ttl?: number, relative?: boolean, onNode: Node }
): Promise<number> {
  if (ttl === 0) return 0
  if (ttl < 0) throw new ArgumentError('ttl', 'greater or equal to 0', ttl)

  if (relative) {
    const { height } = await onNode.getCurrentKeyBlock()
    return +(height) + ttl
  }
  return ttl
}

/**
 * Get the next nonce to be used for a transaction for an account
 *
 * @param accountId
 * @param nonce
 * @returns Next Nonce
 */
export async function getAccountNonce (
  accountId: string,
  { nonce, onNode }:
  { nonce: number, onNode: Node }
): Promise<number> {
  if (nonce != null) return nonce
  const { nonce: accountNonce } = await onNode.getAccountByPubkey(accountId)
    .catch(() => ({ nonce: 0 }))
  return accountNonce + 1
}

/**
 * Calculate fee, get absolute ttl (ttl + height), get account nonce
 *
 * @param txType Type of transaction
 * @param params Object which contains all tx data
 * @returns Object with account nonce, absolute ttl and transaction fee
 */
export async function prepareTxParams (
  txType: TX_TYPE,
  {
    senderId,
    nonce: n,
    ttl: t,
    fee: f,
    gasLimit,
    absoluteTtl,
    vsn,
    strategy,
    showWarning = false,
    onNode
  }: Pick<TxParamsCommon, 'nonce' | 'ttl' | 'fee'> & {
    senderId: EncodedData<'ak'>
    vsn?: number
    gasLimit?: number | string | BigNumber
    absoluteTtl?: number
    strategy?: 'continuity' | 'max'
    showWarning?: boolean
    onNode: Node
  }
): Promise<{
    fee: number | string | BigNumber
    ttl: number
    nonce: number | string | BigNumber
  }> {
  n = n ?? (
    await onNode.getAccountNextNonce(senderId, { strategy }).catch(() => ({ nextNonce: 1 }))
  ).nextNonce as number
  const ttl = await calculateTtl({
    ttl: t as number,
    relative: absoluteTtl == null,
    onNode
  })
  const fee = calculateFee(
    f,
    txType,
    { showWarning, gasLimit, params: { ...arguments[1], nonce: n, ttl }, vsn }
  )
  return { fee, ttl, nonce: n }
}
