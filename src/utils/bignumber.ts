/**
 * Big Number Helpers
 * @module @aeternity/aepp-sdk/es/utils/bignumber
 * @example import { isBigNumber, ceil } from '@aeternity/aepp-sdk/es/utils/bignumber'
 */
import BigNumber from 'bignumber.js'

/**
 * Check if value is BigNumber, Number, BigInt or number string representation
 * @param number number to check
 */
export const isBigNumber = (number: string | number | bigint | BigNumber): boolean => {
  if (typeof number === 'bigint') return true
  return ['number', 'object', 'string'].includes(typeof number) &&
    (!isNaN(number as number) || Number.isInteger(number) || BigNumber.isBigNumber(number))
}

/**
 * BigNumber ceil operation
 * @param {BigNumber} bigNumber
 * @returns {BigNumber}
 */
export const ceil = (bigNumber: BigNumber): BigNumber => bigNumber
  .integerValue(BigNumber.ROUND_CEIL)
