#!/usr/bin/env node
/**
 *
 * npm install commander chainx.js
 * Usage：
 * Set BTC Xrc20 Address：
 *          node dev-deploy-btcxrc20.js -s --key  'your account privatekey'
 *
 * Deposit ChainX X-BTC to Address without real transfer BTC to Bitcoin trustee address (Default would deposit 1 BTC):
 *          node dev-deploy-btcxrc20.js -d <Address>
 * 
 * Deploy exist CodeHash:
 *          node dev-deploy-btcxrc20.js -y <CodeHash>
 *
 *  Claim PCX：
 *          node dev-deploy-btcxrc20.js -c
 *
 */

var program = require('commander');
var fs = require('fs');
const Chainx = require('chainx.js').default;
const { blake2AsU8a } = require('@chainx/util-crypto')
const { compactAddLength, stringCamelCase, u8aToU8a } = require('@chainx/util');
const { Abi } = require('@chainx/api-contract');
const { createType } = require('@chainx/types')


program
    .version('0.1.0')
    .option('-s, --set ', 'Set And Deploy Contract')
    .option('-y, --deploy <VALUE>', 'use hashcode deploy contract')
    .option('--getBlock', 'get inint data')
    .option('--getBest', 'get best data')
    .option('-r, --getResult', 'get game result')
    .option('-l, --getLottery', 'get game result')
    .option('-k, --key [PRIVATEKEY]', 'Set Private Key', '0xabf8e5bdbe30c65656c0a3cbd181ff8a56294a69dfedd27982aace4a76909115')
    .option('-w, --wasm [WASM-PATH]', 'Path of the compiled wasm file', '../target/btc_spv_oracle.wasm')
    .option('-a, --abi [ABI-PATH]', 'Path of the generated ABI file', '../target/metadata.json')
    //.option('-W, --ws [WEBSOCKET]', 'Webscoket of the ChainX node', 'ws://127.0.0.1:8087')
    .option('-W, --ws [WEBSOCKET]', 'Webscoket of the ChainX node', 'wss://testnet.w1.chainx.org.cn/ws')
    .parse(process.argv);

/*
 * parse params
*/
const parseParams = (args, params) => {
    args.forEach((arg, i) => {
        const t = arg.type.type
        if (t.startsWith('u')) {
            params[i] = parseInt(params[i])
        } else if (t === 'bool' && typeof params[i] === 'string') {
            params[i] = JSON.parse(params[i].toLowerCase())
        }
    })
    return params
}

/*
 * we want to know if codehash  exist
 * @param chainx
 * @param codeHash contract codehash
*/
async function isCodeHashExist(chainx, codeHash) {
    const result = await chainx.api.query.xContracts.pristineCode(codeHash)
    if (result.length > 0) {
        return true
    } else {
        return false
    }
}

// Convert a hex string to a byte array
const hexToBytes = hex => {
    for (var bytes = [], c = 0; c < hex.length; c += 2)
        bytes.push(parseInt(hex.substr(c, 2), 16))
    return bytes
}

// Convert a byte array to a hex string
const bytesToHex = bytes => {
    for (var hex = [], i = 0; i < bytes.length; i++) {
        var current = bytes[i] < 0 ? bytes[i] + 256 : bytes[i]
        hex.push((current >>> 4).toString(16))
        hex.push((current & 0xf).toString(16))
    }
    return hex.join('')
}

const littleEndianToBigEndian = hex => {
    const bytes = hexToBytes(hex)
    const reverse = bytes.reverse()
    return bytesToHex(reverse)
}

/**
 *  claim balance to account
 */
async function getAccountBalance(chainx, privateKey) {
    const account = chainx.account.from(privateKey);
    const address = account.address()
    const assets = await chainx.asset.getAssetsByAccount(address, 0, 10);
    const filtered = assets.data.filter(asset => asset.name === "PCX");
    const balance = (filtered.length > 0 ? filtered[0].details.Free : 0);
    return balance / Math.pow(10, 8)
}

/*
 * if contract  exist
 * @param chainx
 * @param address contract address
*/
async function isContractExist(chainx, address) {
    try {
        const result = await chainx.api.query.xContracts.contractInfoOf(address)
        if (result.isEmpty) {
            return false
        } else {
            return true
        }
    } catch (error) {
        console.log(error)
        return false
    }
}

/*
 * upload contract
 * @param chainx
 * @param file gas cb
*/
async function uploadContract(chainx, wasm, gasLimit, Alice) {
    const method = 'putCode'
    let codehash = '0x'
    blake2AsU8a(wasm).forEach(i => {
        codehash += ('0' + i.toString(16)).slice(-2)
    })
    return new Promise(async (reslove, reject) => {
        const isExist = await isCodeHashExist(chainx, codehash)
        if (isExist) {
            console.log('contract code Exist, do not need to upload')
            //reslove(codehash)
            reject(codehash)
            return
        }
        const args = [gasLimit, compactAddLength(wasm)]
        const ex = chainx.api.tx.xContracts[method](...args)
        ex.signAndSend(Alice, acceleration = 20, (error, response) => {
            if (error) {
                console.log(error)
            }
            for (var i = 0; response && response.events && (i < response.events.length); i++) {
                if ('CodeStored' == response.events[i].method) {
                    console.log("upload contract success...", response.events[i].event.data[0])
                    reslove(response.events[i].event.data[0])
                } else if ('ExtrinsicFailed' == response.events[i].method) {
                    console.log("upload failed...", codehash)
                    reslove(codehash)
                }
            }
        })
    })
}

/*
 * upload contract
 * @param chainx
 * @param file gas cb
*/
async function deploy(chainx, _abi, codeHash, params, endowment, gas, Alice) {
    const btcSpvAbi = new Abi(_abi)
    const method = 'instantiate'
    parseParams(btcSpvAbi.constructors[0].args, params)
    const selector = JSON.parse(_abi.contract.constructors[0].selector)
    const args = [
        endowment,
        5000000,
        codeHash,
        selector.reduce((a, b) => a + b.slice(2)) +
        btcSpvAbi.constructors[0](...params).slice(2)
    ]
    console.log('deploy abi in utils ')
    return new Promise((resolve, reject) => {
        const ex = chainx.api.tx.xContracts[method](...args)
        ex.signAndSend(Alice, (error, response) => {
            for (var i = 0; response && response.events && (i < response.events.length); i++) {
                console.log(response.events[i])
                if ('ExtrinsicSuccess' == response.events[i].method) {
                    const event =
                        response.events.find(item => {
                            return item.method === 'Instantiated'
                        })
                    if (event) {
                        // event name "Instantiated", data[0] 为发送人地址，data[1] 为合约地址
                        const contract_address = event.event.data[1]
                        console.log("instance contract success")
                        resolve(contract_address)
                    }
                } else if ('ExtrinsicFailed' == response.events[i].method) {
                    console.log("instance erc20 contract fail")
                    console.log(response.events[i])
                    reject({ err: "instance erc20 contract fail, please make sure you have the right codehash or try the other code hash" })
                }
            }
        })
    })
}

// query Data onchain
async function queryDataOnChain(chainx, abi, contractAddress, method, gas, params, alicePrikey) {
    const parseAbi = new Abi(abi)

    const accountAddress = chainx.account.from(alicePrikey).address();

    parseParams(parseAbi.messages[stringCamelCase(method)].args, params)
    try {
        const obj = {
            origin: accountAddress,
            dest: contractAddress,
            gasLimit: gas,
            inputData: parseAbi.messages[stringCamelCase(method)](...params)
        }
        const result = await chainx.api.rpc.chainx.contractCall(obj)
        if (result.status === 0) {
            const typeObj = parseAbi.messages[stringCamelCase(method)].type
            let returnType = typeObj.displayName
            // const sliceData = '0x' + result.data.slice(4)
            // const data = createType(returnType, u8aToU8a(sliceData)).toJSON()
            if (returnType === 'Option') {
                returnType = typeObj.type
            } else if (returnType === 'Vec') {
                const vecContent = typeObj.params[0].type
                returnType = `Vec<${vecContent}>`
            } else if (returnType === 'BTreeMap') {
                returnType = typeObj.type
            } else if (returnType === 'H256Wrapper') {
                returnType = 'H256'
            }
            let data = createType(
                returnType.replace('{ "elems": "Vec" }<u8>', 'Text'),
                u8aToU8a(result.data)
            ).toJSON()
            //h256 should take special methods, because  contract rcp return littleEndian, so we should revert it to big
            if (returnType === 'H256') {
                data = littleEndianToBigEndian(data)
            }
            return { status: true, result: JSON.stringify(data) }
        } else {
            return { status: false, result: 'status is error' }
        }

    } catch (error) {
        console.log(error)
    }
}


//check if balance enough 
async function init(chainx, alicePrikey) {
    const balance = await getAccountBalance(chainx, alicePrikey)
    console.log('account balance is:' + balance)
    if (balance < 20) {
        /*await claim(chainx, alicePrikey).then(res => {
            console.log(res)
        }).catch(err => {
            console.log("please make sure the account address correct, alicePrikey:", alicePrikey)
            process.exit(0);
        })*/
    }
}

(
    async function () {
        var wasmPath = program.wasm
        var abiPath = program.abi
        var websocket = program.ws
        var alicePrikey = program.key

        var wasm = fs.readFileSync(wasmPath)
        var abi = require(abiPath)
        // node websocket ip and port
        const chainx = new Chainx(websocket);
        let gasLimit = 20000000;

        await chainx.isRpcReady();
        if (program.set) {
            // init contract， check balance, check if contract have been uploaded already
            await init(chainx, alicePrikey)
            console.log('upload hashcode')
            // upload contract
            let codehash = await uploadContract(chainx, wasm, gasLimit, alicePrikey).then(
                res => {
                    if (!res) {
                        console.log("upload contract failed")
                        process.exit(0);
                    }
                    return res
                }
            ).catch(err => {
                console.log("codehash: " + err)
                process.exit(0);
            })
            // print contract codehash
            console.log('codehash :', codehash)
            // contract deploy params
            params = [true]
            // deploy contract 
            let contract_address = await deploy(chainx, abi, codehash, params, 0, gasLimit, alicePrikey).then(
                res => { return res }
            ).catch(err => {
                console.log(err)
                process.exit(0);
            })
            //get contract address
            console.log('contract address: ', contract_address);
            process.exit(0);

        } else if (program.deploy) {
            await init(chainx, alicePrikey)
            let codehash = program.deploy
            console.log('codehash :', codehash)
            params = [false]
            let contract_address = await deploy(chainx, abi, codehash, params, 0, gasLimit, alicePrikey).then(
                res => { return res }
            ).catch(err => {
                console.log(err)
                process.exit(0);
            })
            console.log('contract address: ', contract_address)

        } else if (program.getBlock) {
            const contract_address = '5FZ7LDQXqnbvRRvdZmbK1TSLAUrh9pwX9chCMoWkWzcvQzkr'
            const method = 'get_btc_block_hash'
            params = [233]
            let result = await queryDataOnChain(chainx, abi, contract_address, method, gasLimit, params, alicePrikey)
            console.log(result)
            process.exit(0);

        } else if (program.getBest) {
            const contract_address = '5FEnRDGSAA3pbcaozXZQbGd4CENpFjQc3nwGrfjtzbwHvkVq'
            const method = 'get_best_index'
            params = []
            let result = await queryDataOnChain(chainx, abi, contract_address, method, gasLimit, params, alicePrikey)
            console.log(result)
            process.exit(0);

        }
    }
)();
