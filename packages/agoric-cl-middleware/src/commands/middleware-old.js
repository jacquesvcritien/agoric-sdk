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
// const { agoricNames, fromBoard, vstorage } = await rpc.makeRpcUtils({ fetch });

const delay = ms => new Promise(res => setTimeout(res, ms));

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
      console.log("JOB Request for "+jobId+" succeeded")
      return res
  }
  catch(err){
      console.error("JOB Request for "+jobId+" failed", err)
      return err
  }
  
}

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

export const agoricMain = async () => {
  console.log('Starting oracle bridge');
  const { PORT = '3000', EI_CHAINLINKURL, POLL_INTERVAL = '30' } = process.env;
  assert(EI_CHAINLINKURL, '$EI_CHAINLINKURL is required');

  const credentials = readCredentials();

  assert(POLL_INTERVAL, '$POLL_INTERVAL is required');
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

const makeFakeController = (intervalSeconds, chainlinkUrl, credentials, { atExit }) => {
  const pollInterval = intervalSeconds * 1_000;
  const it = setInterval(() => {

    // updater.updateState();

    let state = readState();

    for (let index in state.jobs){
        state.jobs[index].request_id++;
        let request_id = state.jobs[index].request_id;
        let job = state.jobs[index].job
        console.log("Sending job spec", job, "request", request_id)
        sendJobRun(credentials, request_id, job, chainlinkUrl)
    }
    saveState(state)
    
  }, pollInterval);
  atExit.finally(() => { console.log("HERE");clearInterval(it); });
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

  app.post('/adapter', (req, res) => {
    let state = readState()

    let result = Math.round(req.body.data.result)
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
        console.log("Price change is "+perc_change+"%")

        to_update = perc_change > 0.01
    }

    if(to_update){
        console.log("Updating price!")
        state.previous_results[job_name] = {
            id: job_id,
            result: result
        }
    
        saveState(state);
    }
    
    return !isNaN(result) ? res.status(200).send({success:true}) : res.status(500).send({success:false})
  });

  app.post('/jobs', (req, res) => {
    let new_job = req.body.jobId;

    let state = readState()
    state.jobs.push({
        job: new_job,
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

/**
 *
 * @param {import('anylogger').Logger} logger
 */
 export const testingMiddleware = async logger => {
  
  const marshaller = boardSlottingMarshaller();

  /** @param {import('../lib/psm.js').BridgeAction} bridgeAction */
  const outputAction = bridgeAction => {
    const capData = marshaller.serialize(bridgeAction);
    var data = JSON.stringify(capData)
    return data
  };

  const args = process.argv.slice(2);

  var previousOffer = Number(args[0])
  var price = Number(args[1])
  var from = args[2]

  console.log("offerId", offerId)
  console.log("previousOffer", previousOffer)
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
