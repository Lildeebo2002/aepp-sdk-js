import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import { RestError } from '@azure/core-rest-pipeline';
import { getSdk } from '.';
import { assertNotNull } from '../utils';
import {
  AeSdk,
  decode, encode, Encoding, Encoded,
  Oracle, OracleClient,
  ORACLE_TTL_TYPES, RequestTimedOutError,
} from '../../src';

describe('Oracle', () => {
  let aeSdk: AeSdk;
  let oracle: Oracle;
  let oracleClient: OracleClient;
  const queryResponse = '{"tmp": 30}';

  before(async () => {
    aeSdk = await getSdk(2);
    const expectedOracleId = encode(decode(aeSdk.address), Encoding.OracleAddress);
    oracle = new Oracle(aeSdk.accounts[aeSdk.address], aeSdk.getContext());
    expect(oracle.address).to.be.equal(expectedOracleId);
    oracleClient = new OracleClient(oracle.address, aeSdk.getContext());
    expect(oracleClient.address).to.be.equal(expectedOracleId);
  });

  describe('Oracle', () => {
    it('registers with 5000 TTL', async () => {
      const height = await aeSdk.getHeight();
      await oracle.register(
        '{"city": "str"}',
        '{"tmp": "num"}',
        { oracleTtlType: ORACLE_TTL_TYPES.delta, oracleTtlValue: 5000 },
      );
      const oracleNode = await oracle.getNodeState();
      const ttl = height + 5000;
      expect(oracleNode.ttl).to.be.within(ttl, ttl + 4);
      expect(oracleNode.id).to.be.equal(oracle.address);
    });

    it('extends TTL', async () => {
      const { ttl: ttlBefore } = await oracle.getNodeState();
      await oracle.extendTtl({ oracleTtlType: ORACLE_TTL_TYPES.delta, oracleTtlValue: 7450 });
      const { ttl } = await oracle.getNodeState();
      expect(ttl).to.be.equal(ttlBefore + 7450);
    });

    it('polls for queries', (done) => {
      let count = 0;
      const stopPolling = oracle.pollQueries(() => {
        count += 1;
        expect(count).to.be.lessThanOrEqual(3);
        if (count !== 3) return;
        stopPolling();
        done();
      });
      oracleClient.postQuery('{"city": "Berlin2"}')
        .then(async () => oracleClient.postQuery('{"city": "Berlin3"}'))
        .then(async () => oracleClient.postQuery('{"city": "Berlin4"}'));
    });

    it('responds to query', async () => {
      const { queryId } = await oracleClient.postQuery('{"city": "Berlin"}');
      await oracle.respondToQuery(queryId, queryResponse);

      const query = await aeSdk.api.getOracleQueryByPubkeyAndQueryId(oracle.address, queryId);
      expect(decode(query.response as Encoded.OracleResponse).toString())
        .to.be.equal(queryResponse);
      const response = await oracleClient.pollForResponse(queryId);
      expect(response).to.be.equal(queryResponse);
    });
  });

  describe('OracleClient', () => {
    it('posts query', async () => {
      const query = await oracleClient.postQuery('{"city": "Berlin"}');
      assertNotNull(query.tx?.query);
      expect(query.tx.query).to.be.equal('{"city": "Berlin"}');
    });

    it('polls for response for query without response', async () => {
      const { queryId } = await oracleClient.postQuery('{"city": "Berlin"}', { queryTtlValue: 2 });
      await oracleClient.pollForResponse(queryId).should.be.rejectedWith(RequestTimedOutError);
    });

    it('polls for response for query that is already expired without response', async () => {
      const { queryId } = await oracleClient.postQuery('{"city": "Berlin"}', { queryTtlValue: 2 });
      await aeSdk.awaitHeight(await aeSdk.getHeight() + 3);
      await oracleClient.pollForResponse(queryId).should.be
        .rejectedWith(RestError, 'Query not found');
    });

    it('queries oracle', async () => {
      const stopPolling = oracle.pollQueries((query) => {
        oracle.respondToQuery(query.id, queryResponse);
      });
      const response = await oracleClient.query('{"city": "Berlin"}');
      stopPolling();
      expect(response).to.be.equal(queryResponse);
    });
  });

  describe('Oracle query fee settings', () => {
    let oracleWithFee: Oracle;
    let oracleWithFeeClient: OracleClient;
    const queryFee = 24000n;

    before(async () => {
      oracleWithFee = new Oracle(aeSdk.accounts[aeSdk.addresses()[1]], aeSdk.getContext());
      await oracleWithFee.register('{"city": "str"}', '{"tmp": "num"}', { queryFee: queryFee.toString() });
      oracleWithFeeClient = new OracleClient(oracleWithFee.address, aeSdk.getContext());
    });

    it('Post Oracle Query without query fee', async () => {
      const query = await oracleClient.postQuery('{"city": "Berlin"}');
      assertNotNull(query.tx?.queryFee);
      expect(query.tx.queryFee).to.be.equal(0n);
    });

    it('Post Oracle Query with registered query fee', async () => {
      const query = await oracleWithFeeClient.postQuery('{"city": "Berlin"}');
      assertNotNull(query.tx?.queryFee);
      expect(query.tx.queryFee).to.be.equal(queryFee);
    });

    it('Post Oracle Query with custom query fee', async () => {
      const query = await oracleWithFeeClient
        .postQuery('{"city": "Berlin"}', { queryFee: (queryFee + 2000n).toString() });
      assertNotNull(query.tx?.queryFee);
      expect(query.tx.queryFee).to.be.equal(queryFee + 2000n);
    });
  });
});
