# Plays the wallet: signs eth_signTypedData_v4 JSON the way MetaMask/eth-sig-util does.
import sys, json
from eth_account import Account
from eth_account.messages import encode_typed_data
pk, data = sys.argv[1], json.loads(sys.stdin.read())
signed = Account.from_key(pk).sign_message(encode_typed_data(full_message=data))
print("0x" + signed.signature.hex().removeprefix("0x"))
