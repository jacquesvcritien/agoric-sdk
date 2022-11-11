#!/usr/bin/env node
/* eslint-disable @jessie.js/no-nested-await */
/* global process */
import '@agoric/casting/node-fetch-shim.js';
import '@endo/init';
import '@endo/init/pre.js';

import { agoricMain, testingMiddleware } from './commands/middleware.js';

await agoricMain();
//await testingMiddleware();
