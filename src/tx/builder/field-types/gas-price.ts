import BigNumber from 'bignumber.js';
import coinAmount from './coin-amount';
import { IllegalArgumentError } from '../../../utils/errors';
import { Int, MIN_GAS_PRICE } from '../constants';
import Node from '../../../Node';
import { AE_AMOUNT_FORMATS, formatAmount } from '../../../utils/amount-formatter';

export default {
  ...coinAmount,

  async prepare(
    value: Int | undefined,
    { onNode, denomination }: {
      onNode: Node;
      denomination?: AE_AMOUNT_FORMATS;
    },
  ): Promise<Int> {
    if (value != null) return value;
    // TODO: return undefined if unsupported node version, before major release
    let gasPrice = (await onNode.getRecentGasPrices())[0].minGasPrice;
    // TODO: don't increase gas price if there is empty space in blocks
    gasPrice = BigInt(new BigNumber(gasPrice.toString()).times(1.01).integerValue().toFixed());
    return formatAmount(gasPrice, { targetDenomination: denomination });
  },

  serializeAettos(value: string | undefined = MIN_GAS_PRICE.toString()): string {
    if (+value < MIN_GAS_PRICE) {
      throw new IllegalArgumentError(`Gas price ${value.toString()} must be bigger then ${MIN_GAS_PRICE}`);
    }
    return value;
  },
};
