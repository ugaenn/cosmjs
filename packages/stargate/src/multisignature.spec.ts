import { createMultisigThresholdPubkey, encodeSecp256k1Pubkey, pubkeyToAddress } from "@cosmjs/amino";
import { coins, makeCosmoshubPath, Secp256k1HdWallet } from "@cosmjs/launchpad";
import { assert } from "@cosmjs/utils";

import { MsgSend } from "./codec/cosmos/bank/v1beta1/tx";
import { TxRaw } from "./codec/cosmos/tx/v1beta1/tx";
import { makeMultisignedTx } from "./multisignature";
import { SignerData, SigningStargateClient } from "./signingstargateclient";
import { assertIsBroadcastTxSuccess } from "./stargateclient";
import { faucet, pendingWithoutSimapp, simapp } from "./testutils.spec";

describe("multisignature", () => {
  describe("makeMultisignedTx", () => {
    it("works", async () => {
      pendingWithoutSimapp();
      const wallet0 = await Secp256k1HdWallet.fromMnemonic(faucet.mnemonic, makeCosmoshubPath(0));
      const wallet1 = await Secp256k1HdWallet.fromMnemonic(faucet.mnemonic, makeCosmoshubPath(1));
      const wallet2 = await Secp256k1HdWallet.fromMnemonic(faucet.mnemonic, makeCosmoshubPath(2));
      const wallet3 = await Secp256k1HdWallet.fromMnemonic(faucet.mnemonic, makeCosmoshubPath(3));
      const wallet4 = await Secp256k1HdWallet.fromMnemonic(faucet.mnemonic, makeCosmoshubPath(4));
      const pubkey0 = encodeSecp256k1Pubkey((await wallet0.getAccounts())[0].pubkey);
      const pubkey1 = encodeSecp256k1Pubkey((await wallet1.getAccounts())[0].pubkey);
      const pubkey2 = encodeSecp256k1Pubkey((await wallet2.getAccounts())[0].pubkey);
      const pubkey3 = encodeSecp256k1Pubkey((await wallet3.getAccounts())[0].pubkey);
      const pubkey4 = encodeSecp256k1Pubkey((await wallet4.getAccounts())[0].pubkey);
      const address0 = (await wallet0.getAccounts())[0].address;
      const address1 = (await wallet1.getAccounts())[0].address;
      const address2 = (await wallet2.getAccounts())[0].address;
      const address3 = (await wallet3.getAccounts())[0].address;
      const address4 = (await wallet4.getAccounts())[0].address;
      const multisigPubkey = createMultisigThresholdPubkey([pubkey0, pubkey1, pubkey2, pubkey3, pubkey4], 2);
      const multisigAddress = pubkeyToAddress(multisigPubkey, "cosmos");
      expect(multisigAddress).toEqual("cosmos1h90ml36rcu7yegwduzgzderj2jmq49hcpfclw9");

      const client0 = await SigningStargateClient.connectWithSigner(simapp.tendermintUrl, wallet0);
      const client1 = await SigningStargateClient.connectWithSigner(simapp.tendermintUrl, wallet1);
      const client2 = await SigningStargateClient.connectWithSigner(simapp.tendermintUrl, wallet2);
      const client3 = await SigningStargateClient.connectWithSigner(simapp.tendermintUrl, wallet3);
      const client4 = await SigningStargateClient.connectWithSigner(simapp.tendermintUrl, wallet4);

      const msgSend: MsgSend = {
        fromAddress: multisigAddress,
        toAddress: "cosmos19rvl6ja9h0erq9dc2xxfdzypc739ej8k5esnhg",
        amount: coins(1234, "ucosm"),
      };
      const msg = {
        typeUrl: "/cosmos.bank.v1beta1.MsgSend",
        value: msgSend,
      };
      const gasLimit = 200000;
      const fee = {
        amount: coins(2000, "ucosm"),
        gas: gasLimit.toString(),
      };
      const memo = "Use your tokens wisely";

      const multisigAccount = await client0.getAccount(multisigAddress);
      assert(multisigAccount, "Account does not exist on chain");
      const signerData: SignerData = {
        accountNumber: multisigAccount.accountNumber,
        sequence: multisigAccount.sequence,
        chainId: await client0.getChainId(),
      };

      const {
        bodyBytes,
        signatures: [signature0],
      } = await client0.sign(faucet.address0, [msg], fee, memo, signerData);
      const {
        signatures: [signature1],
      } = await client1.sign(faucet.address1, [msg], fee, memo, signerData);
      const {
        signatures: [signature2],
      } = await client2.sign(faucet.address2, [msg], fee, memo, signerData);
      const {
        signatures: [signature3],
      } = await client3.sign(faucet.address3, [msg], fee, memo, signerData);
      const {
        signatures: [signature4],
      } = await client4.sign(faucet.address4, [msg], fee, memo, signerData);

      const signatures = new Map<string, Uint8Array>([
        [address0, signature0],
        [address1, signature1],
        [address2, signature2],
        [address3, signature3],
        [address4, signature4],
      ]);
      const signedTx = makeMultisignedTx(
        multisigPubkey,
        multisigAccount.sequence,
        fee,
        bodyBytes,
        signatures,
      );

      // ensure signature is valid
      const result = await client0.broadcastTx(Uint8Array.from(TxRaw.encode(signedTx).finish()));
      assertIsBroadcastTxSuccess(result);
    });
  });
});
