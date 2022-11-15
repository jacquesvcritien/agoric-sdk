import { Command } from 'commander';
import { inspect } from 'util';
import {
  boardSlottingMarshaller,
  makeRpcUtils,
  storageHelper,
  networkConfig
} from '../lib/rpc.js';
import {
    makeFollower,
    makeLeader,
  } from '@agoric/casting';
import { coalesceWalletState } from '@agoric/smart-wallet/src/utils.js';
import { readFile } from './helper.js'

import { getCurrent } from '../lib/wallet.js';

const { agoricNames, fromBoard, vstorage } = await makeRpcUtils({ fetch });

var feeds = []


const readOracleAddresses = () => {
    var fileInput = readFile("oracles.txt")
    console.log(fileInput)
    var addresses = fileInput.split(",")
    var oracles = {}
    for (let addr of addresses) {
      addr = addr.replaceAll("\n", "")
      oracles[addr] = {}
    }
    return oracles
}

var oracles = readOracleAddresses();
console.log(oracles)

export const monitor = async() => {
    for (let key in agoricNames.instance) {
        if(key.includes("price feed")){
            let feed = key.split(" price feed")[0]
            let boardId = agoricNames.instance[key].boardId
            feeds.push({
                feed: feed,
                boardId: boardId
            })
        }
    }
    feeds = agoricNames.reverse
    console.log(feeds)

    for (let oracle in oracles){
        const { fromBoard } = await makeRpcUtils({
            fetch,
        });
    
        const unserializer = boardSlottingMarshaller(fromBoard.convertSlotToVal);
    
        const leader = makeLeader(networkConfig.rpcAddrs[0]);
        const follower = await makeFollower(
            `:published.wallet.${oracle}`,
            leader,
            {
                // @ts-expect-error xxx
                unserializer,
            },
        );

        const coalesced = await coalesceWalletState(follower);
        const current = await getCurrent(oracle, fromBoard, {
            vstorage,
        });

        const invitations = current.offerToUsedInvitation
 

        for (let inv in invitations) {

           let boardId = invitations[inv].value[0].instance.boardId
           let feed = feeds[boardId].split(" price feed")[0]
           oracles[oracle][feed] = inv
        }
    }

    

    console.log(oracles)
}
