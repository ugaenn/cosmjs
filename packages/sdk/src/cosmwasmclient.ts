import { Sha256 } from "@iov/crypto";
import { Encoding } from "@iov/encoding";

import { makeSignBytes, marshalTx } from "./encoding";
import { findAttribute, Log, parseLogs } from "./logs";
import { BlockResponse, RestClient, TxsResponse } from "./restclient";
import {
  Coin,
  CosmosSdkAccount,
  CosmosSdkTx,
  MsgExecuteContract,
  MsgInstantiateContract,
  MsgSend,
  MsgStoreCode,
  StdFee,
  StdSignature,
} from "./types";

export interface FeeTable {
  readonly upload: StdFee;
  readonly init: StdFee;
  readonly exec: StdFee;
  readonly send: StdFee;
}

function singleAmount(amount: number, denom: string): readonly Coin[] {
  return [{ amount: amount.toString(), denom: denom }];
}

const defaultFees: FeeTable = {
  upload: {
    amount: singleAmount(25000, "ucosm"),
    gas: "1000000", // one million
  },
  init: {
    amount: singleAmount(12500, "ucosm"),
    gas: "500000", // 500k
  },
  exec: {
    amount: singleAmount(5000, "ucosm"),
    gas: "200000", // 200k
  },
  send: {
    amount: singleAmount(2000, "ucosm"),
    gas: "80000", // 80k
  },
};

export interface SigningCallback {
  (signBytes: Uint8Array): Promise<StdSignature>;
}

interface SigningData {
  readonly senderAddress: string;
  readonly signCallback: SigningCallback;
}

export interface GetNonceResult {
  readonly accountNumber: number;
  readonly sequence: number;
}

export interface PostTxResult {
  readonly logs: readonly Log[];
  readonly rawLog: string;
  /** Transaction hash (might be used as transaction ID). Guaranteed to be non-exmpty upper-case hex */
  readonly transactionHash: string;
}

export interface SearchByIdQuery {
  readonly id: string;
}

export interface SearchByHeightQuery {
  readonly height: number;
}

export interface SearchBySentFromOrToQuery {
  readonly sentFromOrTo: string;
}

export type SearchTxQuery = SearchByIdQuery | SearchByHeightQuery | SearchBySentFromOrToQuery;

function isSearchByIdQuery(query: SearchTxQuery): query is SearchByIdQuery {
  return (query as SearchByIdQuery).id !== undefined;
}

function isSearchByHeightQuery(query: SearchTxQuery): query is SearchByHeightQuery {
  return (query as SearchByHeightQuery).height !== undefined;
}

function isSearchBySentFromOrToQuery(query: SearchTxQuery): query is SearchBySentFromOrToQuery {
  return (query as SearchBySentFromOrToQuery).sentFromOrTo !== undefined;
}

export interface ExecuteResult {
  readonly logs: readonly Log[];
}

export class CosmWasmClient {
  public static makeReadOnly(url: string): CosmWasmClient {
    return new CosmWasmClient(url, undefined, {});
  }

  public static makeWritable(
    url: string,
    senderAddress: string,
    signCallback: SigningCallback,
    feeTable?: Partial<FeeTable>,
  ): CosmWasmClient {
    return new CosmWasmClient(
      url,
      {
        senderAddress: senderAddress,
        signCallback: signCallback,
      },
      feeTable || {},
    );
  }

  private readonly restClient: RestClient;
  private readonly signingData: SigningData | undefined;
  private readonly fees: FeeTable;

  private get senderAddress(): string {
    if (!this.signingData) throw new Error("Signing data not set in this client");
    return this.signingData.senderAddress;
  }

  private get signCallback(): SigningCallback {
    if (!this.signingData) throw new Error("Signing data not set in this client");
    return this.signingData.signCallback;
  }

  private constructor(url: string, signingData: SigningData | undefined, customFees: Partial<FeeTable>) {
    this.restClient = new RestClient(url);
    this.signingData = signingData;
    this.fees = { ...defaultFees, ...customFees };
  }

  public async chainId(): Promise<string> {
    const response = await this.restClient.nodeInfo();
    return response.node_info.network;
  }

  /**
   * Returns a 32 byte upper-case hex transaction hash (typically used as the transaction ID)
   */
  public async getIdentifier(tx: CosmosSdkTx): Promise<string> {
    // We consult the REST API because we don't have a local amino encoder
    const bytes = await this.restClient.encodeTx(tx);
    const hash = new Sha256(bytes).digest();
    return Encoding.toHex(hash).toUpperCase();
  }

  /**
   * Returns account number and sequence.
   *
   * Throws if the account does not exist on chain.
   *
   * @param address returns data for this address. When unset, the client's sender adddress is used.
   */
  public async getNonce(address?: string): Promise<GetNonceResult> {
    const account = await this.getAccount(address);
    if (!account) {
      throw new Error(
        "Account does not exist on chain. Send some tokens there before trying to query nonces.",
      );
    }
    return {
      accountNumber: account.account_number,
      sequence: account.sequence,
    };
  }

  public async getAccount(address?: string): Promise<CosmosSdkAccount | undefined> {
    const account = await this.restClient.authAccounts(address || this.senderAddress);
    const value = account.result.value;
    return value.address === "" ? undefined : value;
  }

  /**
   * Gets block header and meta
   *
   * @param height The height of the block. If undefined, the latest height is used.
   */
  public async getBlock(height?: number): Promise<BlockResponse> {
    if (height !== undefined) {
      return this.restClient.blocks(height);
    } else {
      return this.restClient.blocksLatest();
    }
  }

  public async searchTx(query: SearchTxQuery): Promise<readonly TxsResponse[]> {
    // TODO: we need proper pagination support
    function limited(originalQuery: string): string {
      return `${originalQuery}&limit=75`;
    }

    if (isSearchByIdQuery(query)) {
      return (await this.restClient.txs(`tx.hash=${query.id}`)).txs;
    } else if (isSearchByHeightQuery(query)) {
      return (await this.restClient.txs(`tx.height=${query.height}`)).txs;
    } else if (isSearchBySentFromOrToQuery(query)) {
      // We cannot get both in one request (see https://github.com/cosmos/gaia/issues/75)
      const sent = (await this.restClient.txs(limited(`message.sender=${query.sentFromOrTo}`))).txs;
      const received = (await this.restClient.txs(limited(`transfer.recipient=${query.sentFromOrTo}`))).txs;
      const sentHashes = sent.map(t => t.txhash);
      return [...sent, ...received.filter(t => !sentHashes.includes(t.txhash))];
    } else {
      throw new Error("Unknown query type");
    }
  }

  public async postTx(tx: Uint8Array): Promise<PostTxResult> {
    const result = await this.restClient.postTx(tx);
    if (result.code) {
      throw new Error(`Error when posting tx. Code: ${result.code}; Raw log: ${result.raw_log}`);
    }

    if (!result.txhash.match(/^([0-9A-F][0-9A-F])+$/)) {
      throw new Error("Received ill-formatted txhash. Must be non-empty upper-case hex");
    }

    return {
      logs: parseLogs(result.logs) || [],
      rawLog: result.raw_log || "",
      transactionHash: result.txhash,
    };
  }

  /** Uploads code and returns a code ID */
  public async upload(wasmCode: Uint8Array, memo = ""): Promise<number> {
    const storeCodeMsg: MsgStoreCode = {
      type: "wasm/store-code",
      value: {
        sender: this.senderAddress,
        // eslint-disable-next-line @typescript-eslint/camelcase
        wasm_byte_code: Encoding.toBase64(wasmCode),
        source: "",
        builder: "",
      },
    };
    const fee = this.fees.upload;
    const { accountNumber, sequence } = await this.getNonce();
    const chainId = await this.chainId();
    const signBytes = makeSignBytes([storeCodeMsg], fee, chainId, memo, accountNumber, sequence);
    const signature = await this.signCallback(signBytes);
    const signedTx = {
      msg: [storeCodeMsg],
      fee: fee,
      memo: memo,
      signatures: [signature],
    };

    const result = await this.postTx(marshalTx(signedTx));
    const codeIdAttr = findAttribute(result.logs, "message", "code_id");
    const codeId = Number.parseInt(codeIdAttr.value, 10);
    return codeId;
  }

  public async instantiate(
    codeId: number,
    initMsg: object,
    memo = "",
    transferAmount?: readonly Coin[],
  ): Promise<string> {
    const instantiateMsg: MsgInstantiateContract = {
      type: "wasm/instantiate",
      value: {
        sender: this.senderAddress,
        // eslint-disable-next-line @typescript-eslint/camelcase
        code_id: codeId.toString(),
        // eslint-disable-next-line @typescript-eslint/camelcase
        init_msg: initMsg,
        // eslint-disable-next-line @typescript-eslint/camelcase
        init_funds: transferAmount || [],
      },
    };
    const fee = this.fees.init;
    const { accountNumber, sequence } = await this.getNonce();
    const chainId = await this.chainId();
    const signBytes = makeSignBytes([instantiateMsg], fee, chainId, memo, accountNumber, sequence);

    const signature = await this.signCallback(signBytes);
    const signedTx = {
      msg: [instantiateMsg],
      fee: fee,
      memo: memo,
      signatures: [signature],
    };

    const result = await this.postTx(marshalTx(signedTx));
    const contractAddressAttr = findAttribute(result.logs, "message", "contract_address");
    return contractAddressAttr.value;
  }

  public async execute(
    contractAddress: string,
    handleMsg: object,
    memo = "",
    transferAmount?: readonly Coin[],
  ): Promise<ExecuteResult> {
    const executeMsg: MsgExecuteContract = {
      type: "wasm/execute",
      value: {
        sender: this.senderAddress,
        contract: contractAddress,
        msg: handleMsg,
        // eslint-disable-next-line @typescript-eslint/camelcase
        sent_funds: transferAmount || [],
      },
    };
    const fee = this.fees.exec;
    const { accountNumber, sequence } = await this.getNonce();
    const chainId = await this.chainId();
    const signBytes = makeSignBytes([executeMsg], fee, chainId, memo, accountNumber, sequence);
    const signature = await this.signCallback(signBytes);
    const signedTx = {
      msg: [executeMsg],
      fee: fee,
      memo: memo,
      signatures: [signature],
    };

    const result = await this.postTx(marshalTx(signedTx));
    return {
      logs: result.logs,
    };
  }

  public async sendTokens(
    recipientAddress: string,
    transferAmount: readonly Coin[],
    memo = "",
  ): Promise<PostTxResult> {
    const sendMsg: MsgSend = {
      type: "cosmos-sdk/MsgSend",
      value: {
        // eslint-disable-next-line @typescript-eslint/camelcase
        from_address: this.senderAddress,
        // eslint-disable-next-line @typescript-eslint/camelcase
        to_address: recipientAddress,
        amount: transferAmount,
      },
    };
    const fee = this.fees.send;
    const { accountNumber, sequence } = await this.getNonce();
    const chainId = await this.chainId();
    const signBytes = makeSignBytes([sendMsg], fee, chainId, memo, accountNumber, sequence);
    const signature = await this.signCallback(signBytes);
    const signedTx = {
      msg: [sendMsg],
      fee: fee,
      memo: memo,
      signatures: [signature],
    };

    return this.postTx(marshalTx(signedTx));
  }

  /**
   * Returns the data at the key if present (raw contract dependent storage data)
   * or null if no data at this key.
   *
   * Promise is rejected when contract does not exist.
   */
  public async queryContractRaw(address: string, key: Uint8Array): Promise<Uint8Array | null> {
    // just test contract existence
    const _info = await this.restClient.getContractInfo(address);

    return this.restClient.queryContractRaw(address, key);
  }

  /**
   * Makes a "smart query" on the contract, returns raw data
   *
   * Promise is rejected when contract does not exist.
   * Promise is rejected for invalid query format.
   */
  public async queryContractSmart(address: string, queryMsg: object): Promise<Uint8Array> {
    try {
      return await this.restClient.queryContractSmart(address, queryMsg);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "not found: contract") {
          throw new Error(`No contract found at address "${address}"`);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }
}
