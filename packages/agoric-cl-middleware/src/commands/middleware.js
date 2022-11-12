/* eslint-disable no-await-in-loop */
/* eslint-disable @jessie.js/no-nested-await */
// @ts-check
/* eslint-disable func-names */
/* global fetch, process */

import { execSwingsetTransaction } from '../lib/chain.js';
import {
  makeRpcUtils,
  boardSlottingMarshaller,
  networkConfig
} from '../lib/rpc.js'
import axios from 'axios';
import http from 'http';
import fs from 'fs';
import bodyParser from 'body-parser';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import express from 'express';

const { agoricNames, fromBoard, vstorage } = await makeRpcUtils({ fetch });

const delay = ms => new Promise(res => setTimeout(res, ms));
const marshaller = boardSlottingMarshaller();

//get variables and perform validation
const { PORT = '3000', EI_CHAINLINKURL, POLL_INTERVAL = '60', FROM, DECIMAL_PLACES = 6, PRICE_DEVIATION_PERC = 0.1 } = process.env;
assert(EI_CHAINLINKURL, '$EI_CHAINLINKURL is required');
assert(Number(DECIMAL_PLACES), '$DECIMAL_PLACES is required');
assert(Number(PRICE_DEVIATION_PERC), '$PRICE_DEVIATION_PERC is required');
assert(FROM, '$FROM is required');

//helper functions for preserving state
const saveState = (newState) => {
  let data = JSON.stringify(newState);
  fs.writeFileSync('state.json', data);
}

const readJSONFile = (filename) => {
  let rawdata = fs.readFileSync(filename);
  let data = JSON.parse(String(rawdata));
  return data
}

const readState = () => {   
  return readJSONFile("state.json")
}

const readCredentials = () => {
  return readJSONFile("credentials.json")
}

//read initiator credentials
const credentials = readCredentials();

//function to send a job run to the CL node
const sendJobRun = async (credentials, count, jobId, chainlinkUrl) => {
  const options = {
      url: chainlinkUrl+"/v2/jobs/"+jobId+"/runs",
      body: {
          "payment": 0,
          "request_id": count
      },
      headers: {
          "Content-Type": "application/json",
          "X-Chainlink-EA-AccessKey": credentials["EI_IC_ACCESSKEY"],
          "X-Chainlink-EA-Secret": credentials["EI_IC_SECRET"]
      },
      method: 'POST',
  };

  try{
      let res = await axios.post(options.url, options.body, { timeout: 60000, proxy:false, headers: options.headers, httpAgent: new http.Agent({ keepAlive: true })});
      return res
  }
  catch(err){
      console.error("JOB Request for "+jobId+" failed", err)
      return err
  }
  
}


export const agoricMain = async () => {
  console.log('Starting oracle bridge');

  const intervalSeconds = parseInt(POLL_INTERVAL, 10);
  assert(!isNaN(intervalSeconds), `$POLL_INTERVAL ${POLL_INTERVAL} must be a number`);

  const { exit, atExit } = makeExiter();

  const powers = { exit, atExit };

  startBridge(PORT, powers);
  let seconds_left = 60 - (new Date().getSeconds());
  setTimeout(() => {
    let controller = makeFakeController(intervalSeconds, EI_CHAINLINKURL, credentials, powers);
  }, seconds_left*1000)

  return atExit;
};

const queryPrice = async (job_name) => {
  const capDataStr = await vstorage.readLatest(
    `published.priceFeed.${job_name}_price_feed`,
  );

  var capData = JSON.parse(JSON.parse(capDataStr).value)
  capData = JSON.parse(capData.values[0])
  capData = JSON.parse(capData.body.replaceAll("\\", "")).quoteAmount.value[0]
  
  var latest_price = Number(capData.amountOut.value.digits) / Number(capData.amountIn.value.digits)
  console.log(job_name+ " Price Query: "+ String(latest_price))
  return latest_price
}

const submitNewJobIndex = (state, index) => {
  state.jobs[index].request_id++;
  let request_id = state.jobs[index].request_id;
  let job = state.jobs[index].job
  console.log("Sending job spec", job, "request", request_id)
  sendJobRun(credentials, request_id, job, EI_CHAINLINKURL)
}

const makeFakeController = (intervalSeconds, chainlinkUrl, credentials, { atExit }) => {
  const pollInterval = intervalSeconds * 1_000;
  const it = setInterval(() => {

    let state = readState();

    for (let index in state.jobs){
      submitNewJobIndex(state, index)
    }
    saveState(state)
    
  }, pollInterval);

  const it2 = setInterval(async () => {

    let state = readState();

    //for each feed
    for (var i = 0; i < state.jobs.length; i++) {
      let job_name = state.jobs[i].name;

      //query the price
      let latest_price = await queryPrice(job_name)
      let current_price = state.previous_results[job_name].result

      //update latest price
      state.previous_results[job_name].result = latest_price
      saveState(state)

      //if there's a price deviation
      let price_dev = Math.abs((latest_price - current_price)/current_price)*100
      if (price_dev > PRICE_DEVIATION_PERC) {
        console.log("Initialising new CL job request. Found a price deviation for", job_name, "of", price_dev, "%. Latest price:", latest_price," Current Price:", current_price)
        //get job name
        let job_name = state.jobs[i].name
        //if a request hadnt been made yet
        if (state.jobs[i].request_id == state.previous_results[job_name].request_id) {
          //submit job
          submitNewJobIndex(state, i)
        }
      }

    }

  }, 5000);
  atExit.finally(() => { console.log("HERE");clearInterval(it);clearInterval(it2); });
  return Far('fakeController', {
    // methods
  });
}

const startBridge = (PORT, { atExit, exit }) => {
  console.log("Bridge started")
  const app = express();
  app.use(bodyParser.json());
  let state = readState()

  app.get('/', (req, res) => {
    console.log("State after change", state)
    res.end('Hello, world!');
  });

  app.post('/adapter', async (req, res) => {
    let state = readState()

    let result = Math.round(req.body.data.result)
    result = Number(result) / Math.pow(10, Number(DECIMAL_PLACES))
    let request_id = String(req.body.data.request_id)
    let job_id = req.body.data.job
    let job_name = req.body.data.name
    console.log("Bridge received "+String(result)+ " for "+job_name+" ("+request_id+")")

    //get last price
    let last_price = (state.previous_results[job_name]) ? state.previous_results[job_name].result : -1

    let to_update = last_price == -1
    //if last price is found
    if (last_price != -1){
        //calculate percentage change
        let perc_change = Math.abs((result - last_price)/last_price)*100
        console.log("Price change is "+perc_change+"%. Last Price: "+String(result)+". Current Price: "+String(last_price))

        to_update = perc_change > PRICE_DEVIATION_PERC
    }

    if(to_update){
        console.log("Sending price on chain!")
        console.log("Updating price!")
        state.previous_results[job_name] = {
            id: job_id,
            result: result,
            request_id: request_id
        }
        saveState(state);

        await pushPrice(result, job_name, FROM)
    }
    
    return !isNaN(result) ? res.status(200).send({success:true}) : res.status(500).send({success:false})
  });

  app.post('/jobs', (req, res) => {
    let new_job = req.body.jobId;
    let new_job_name = req.body.params.name;

    let state = readState()
    state.jobs.push({
        job: new_job,
        name: new_job_name,
        request_id: 0
    });
    saveState(state)
    console.log("Got new job", new_job)
    console.log("new jobs", state.jobs)
    res.status(200).send({success:true})
  });

  app.delete('/jobs/:id', (req, res) => {
    let job_id = req.params.id;
    console.log("Removing job", job_id)

    let state = readState()

    //loop through jobs
    for(var index in state.jobs){
        if(state.jobs[index].job == job_id){
            state.jobs.splice(index, 1);
            break;
        }
    }

    console.log("new jobs", state.jobs)
    saveState(state)
    res.status(200).send({success:true})
  });

  const listener = app.listen(PORT, '0.0.0.0', () => {
    console.log(`External adapter listening on port`, PORT);
  });

  listener.on('error', err => { exit(err) })
  atExit.finally(() => { listener.close(); });
}

function makeExiter() {
  const exitP = makePromiseKit();
  const exit = (status = 0) => {
    if (typeof status !== 'number') {
      console.log(`Rejecting exit promise with`, status);
      exitP.reject(status);
      throw status;
    }
    console.log(`Resolving exit promise with`, status);
    exitP.resolve(status);
    return status;
  }

  return {
    exit,
    atExit: exitP.promise,
  };
}


/** @param {import('../lib/psm.js').BridgeAction} bridgeAction */
const outputAction = bridgeAction => {
  const capData = marshaller.serialize(bridgeAction);
  var data = JSON.stringify(capData)
  return data
};

const pushPrice = async (price, feed, from) => {

  var offerId = Date.now()

  let state = readState()

  let previousOffer = state.offers[feed]

  const offer = {
    id: Number(offerId),
    invitationSpec: {
        source: 'continuing',
        previousOffer: Number(previousOffer),
        invitationMakerName: 'makePushPriceInvitation',
        invitationArgs: harden([String(price)]),
    },
    proposal: {},
  };
    
  var data = outputAction({
    method: 'executeOffer',
    // @ts-ignore
    offer,
  });

  data = JSON.parse(data)

  var keyring = {
    "home": "",
    "backend": "test"
  }

  execSwingsetTransaction(
    "wallet-action --allow-spend '"+JSON.stringify(data)+"'",
    networkConfig,
    from,
    false,
    keyring,
  );
}
/**
 *
 * @param {import('anylogger').Logger} logger
 */
 export const testingMiddleware = async logger => {
  
  const marshaller = boardSlottingMarshaller();

  const args = process.argv.slice(2);

  var price = Number(args[1])
  var from = args[2]

  console.log("offerId", offerId)
  console.log("price", price)

  var counter = 1
  while (true) {
    var offerId = Date.now()
    const offer = {
      id: Number(offerId),
      invitationSpec: {
          source: 'continuing',
          previousOffer: previousOffer,
          invitationMakerName: 'makePushPriceInvitation',
          invitationArgs: harden([String(counter)]),
      },
      proposal: {},
      };
      
      var data = outputAction({
      method: 'executeOffer',
      offer,
      });

      data = JSON.parse(data)
  
      var keyring = {
        "home": "",
        "backend": "test"
      }
  
      execSwingsetTransaction(
        "wallet-action --allow-spend '"+JSON.stringify(data)+"'",
        networkConfig,
        from,
        false,
        keyring,
      );

      counter+=1;
      await delay(30000)
  }

  
    
};


// console.warn('Now execute the prepared offer');
