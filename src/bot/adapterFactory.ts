import type { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import { SodexAdapter } from '../adapters/sodex_adapter.js';
import { DangoAdapter } from '../adapters/dango_adapter.js';
import { DecibelAdapter } from '../adapters/decibel_adapter.js';
import { HibachiAdapter } from '../adapters/hibachi_adapter.js';
import { OndoPerpsAdapter } from '../adapters/ondoperps_adapter.js';
import type { BotCredentials } from './CredentialStore.js';

/**
 * Create an exchange adapter from explicit credentials.
 *
 * Used by TenantContext when loading bots for a wallet tenant — credentials
 * are decrypted from CredentialStore and passed directly here, never read
 * from process.env.
 *
 * @param exchange    - Exchange name ('sodex', 'dango', 'decibel')
 * @param credentials - Decrypted credentials for this bot
 */
export function createAdapterFromCredentials(
  exchange: string,
  credentials: BotCredentials,
): ExchangeAdapter {
  const exchangeLower = exchange.toLowerCase();

  switch (exchangeLower) {
    case 'sodex': {
      const { apiKey, apiSecret, subaccount } = credentials;
      if (!apiKey || !apiSecret || !subaccount) {
        throw new Error(
          `Missing SoDEX credentials. Required: apiKey, apiSecret, subaccount`
        );
      }
      console.log(`[adapterFactory] Creating SodexAdapter from stored credentials`);
      return new SodexAdapter(apiKey, apiSecret, subaccount);
    }

    case 'dango': {
      const { dangoPrivateKey, userAddress, network = 'mainnet' } = credentials;
      if (!dangoPrivateKey || !userAddress) {
        throw new Error(
          `Missing Dango credentials. Required: dangoPrivateKey, userAddress`
        );
      }
      console.log(`[adapterFactory] Creating DangoAdapter from stored credentials, network: ${network}`);
      return new DangoAdapter(dangoPrivateKey, userAddress, network);
    }

    case 'decibel': {
      const {
        privateKey,
        nodeApiKey = '',
        subaccount = '',
        builderAddress = '',
        gasStationApiKey,
      } = credentials;
      if (!privateKey) {
        throw new Error(
          `Missing Decibel credentials. Required: privateKey`
        );
      }
      console.log(`[adapterFactory] Creating DecibelAdapter from stored credentials`);
      return new DecibelAdapter(
        privateKey,
        nodeApiKey,
        subaccount,
        builderAddress,
        10, // builderFeeBps
        gasStationApiKey,
      );
    }

    case 'hibachi': {
      const {
        hibachiApiKey,
        hibachiAccountType,
        hibachiPrivateKey,
        hibachiSecretKey,
        hibachiAccountId,
      } = credentials;
      if (!hibachiApiKey) {
        throw new Error(
          `Missing Hibachi credentials. Required: hibachiApiKey`
        );
      }
      if (!hibachiAccountType) {
        throw new Error(
          `Missing Hibachi credentials. Required: hibachiAccountType ('trustless' or 'exchange_managed')`
        );
      }
      if (!hibachiAccountId) {
        throw new Error(
          `Missing Hibachi credentials. Required: hibachiAccountId (numeric account ID from the Hibachi dashboard)`
        );
      }
      console.log(`[adapterFactory] Creating HibachiAdapter from stored credentials, accountType: ${hibachiAccountType}`);
      return new HibachiAdapter({
        apiKey: hibachiApiKey,
        accountId: hibachiAccountId,
        accountType: hibachiAccountType,
        privateKey: hibachiPrivateKey,
        secretKey: hibachiSecretKey,
      });
    }

    case 'ondoperps': {
      const { apiKeyId, apiKeySecret, baseUrl } = credentials;
      if (!apiKeyId || !apiKeySecret) {
        throw new Error(
          `Missing OndoPerps credentials. Required: apiKeyId, apiKeySecret`
        );
      }
      console.log(`[adapterFactory] Creating OndoPerpsAdapter from stored credentials`);
      return new OndoPerpsAdapter({
        apiKeyId,
        apiKeySecret,
        baseUrl
      });
    }

    default:
      throw new Error(
        `Unsupported exchange: "${exchange}". Supported exchanges: sodex, dango, decibel, hibachi, ondoperps`
      );
  }
}

/**
 * Create an exchange adapter from env var prefix (legacy / single-operator mode).
 *
 * Used when running without TenantRegistry (single-bot mode, local dev).
 * Reads credentials from process.env using the credentialKey prefix.
 *
 * @param exchange      - Exchange name ('sodex', 'dango', 'decibel')
 * @param credentialKey - Env var prefix (e.g. 'SODEX' → SODEX_API_KEY, SODEX_API_SECRET)
 */
export function createAdapter(exchange: string, credentialKey: string): ExchangeAdapter {
  const exchangeLower = exchange.toLowerCase();
  const envPrefix = credentialKey.toUpperCase();

  switch (exchangeLower) {
    case 'sodex': {
      const apiKey = process.env[`${envPrefix}_API_KEY`];
      const apiSecret = process.env[`${envPrefix}_API_SECRET`];
      const subaccount = process.env[`${envPrefix}_SUBACCOUNT`];

      if (!apiKey || !apiSecret || !subaccount) {
        throw new Error(
          `Missing credentials for ${exchange}. Required env vars: ` +
          `${credentialKey}_API_KEY, ${credentialKey}_API_SECRET, ${credentialKey}_SUBACCOUNT`
        );
      }

      console.log(`[adapterFactory] Creating SodexAdapter with credentialKey: ${credentialKey}`);
      return new SodexAdapter(apiKey, apiSecret, subaccount);
    }

    case 'dango': {
      const privateKey = process.env[`${envPrefix}_PRIVATE_KEY`];
      const userAddress = process.env[`${envPrefix}_USER_ADDRESS`];
      const network = (process.env[`${envPrefix}_NETWORK`] ?? 'mainnet') as 'mainnet' | 'testnet';

      if (!privateKey || !userAddress) {
        throw new Error(
          `Missing credentials for ${exchange}. Required env vars: ` +
          `${envPrefix}_PRIVATE_KEY, ${envPrefix}_USER_ADDRESS`
        );
      }

      console.log(`[adapterFactory] Creating DangoAdapter with credentialKey: ${credentialKey}, network: ${network}`);
      return new DangoAdapter(privateKey, userAddress, network);
    }

    case 'decibel': {
      const privateKey = process.env[`${envPrefix}_PRIVATE_KEY`];
      const nodeApiKey = process.env[`${envPrefix}_NODE_API_KEY`] ?? '';
      const subaccount = process.env[`${envPrefix}_SUBACCOUNT`] ?? '';
      const builderAddress = process.env[`${envPrefix}_BUILDER_ADDRESS`]?.trim() ?? '';
      const gasStationApiKey = process.env[`${envPrefix}_GAS_STATION_API_KEY`];

      if (!privateKey) {
        throw new Error(
          `Missing credentials for ${exchange}. Required env var: ${envPrefix}_PRIVATE_KEY`
        );
      }

      console.log(`[adapterFactory] Creating DecibelAdapter with credentialKey: ${credentialKey}`);
      return new DecibelAdapter(
        privateKey,
        nodeApiKey,
        subaccount,
        builderAddress,
        10,
        gasStationApiKey,
      );
    }

    case 'hibachi': {
      const apiKey = process.env[`${credentialKey}_API_KEY`];
      const accountId = process.env[`${credentialKey}_ACCOUNT_ID`];
      const accountType = process.env[`${credentialKey}_ACCOUNT_TYPE`] as 'trustless' | 'exchange_managed' | undefined;
      const privateKey = process.env[`${credentialKey}_PRIVATE_KEY`];
      const secretKey = process.env[`${credentialKey}_SECRET_KEY`];

      if (!apiKey) {
        throw new Error(
          `Missing credentials for ${exchange}. Required env var: ${credentialKey}_API_KEY`
        );
      }
      if (!accountId) {
        throw new Error(
          `Missing credentials for ${exchange}. Required env var: ${credentialKey}_ACCOUNT_ID`
        );
      }
      if (!accountType) {
        throw new Error(
          `Missing credentials for ${exchange}. Required env var: ${credentialKey}_ACCOUNT_TYPE ('trustless' or 'exchange_managed')`
        );
      }

      console.log(`[adapterFactory] Creating HibachiAdapter with credentialKey: ${credentialKey}, accountType: ${accountType}`);
      return new HibachiAdapter({
        apiKey,
        accountId,
        accountType,
        privateKey,
        secretKey,
      });
    }

    case 'ondoperps': {
      const apiKeyId = process.env[`${envPrefix}_API_KEY_ID`];
      const apiKeySecret = process.env[`${envPrefix}_API_KEY_SECRET`];
      const baseUrl = process.env[`${envPrefix}_BASE_URL`];

      if (!apiKeyId || !apiKeySecret) {
        throw new Error(
          `Missing credentials for ${exchange}. Required env vars: ` +
          `${credentialKey}_API_KEY_ID, ${credentialKey}_API_KEY_SECRET`
        );
      }

      console.log(`[adapterFactory] Creating OndoPerpsAdapter with credentialKey: ${credentialKey}`);
      return new OndoPerpsAdapter({
        apiKeyId,
        apiKeySecret,
        baseUrl
      });
    }

    default:
      throw new Error(
        `Unsupported exchange: "${exchange}". Supported exchanges: sodex, dango, decibel, hibachi, ondoperps`
      );
  }
}
