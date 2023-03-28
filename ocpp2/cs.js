// CS: Charging Station
// 

'use strict';

const Websocket = require('ws');

// This will validate incoming and outgoing ocpp2.0.1 messages
// for proper format
const Validator = require('jsonschema').Validator;
const schema_val = new Validator();
// we need this for reading the validation schema
const fs = require('fs');

let ReconnectingWebSocket = require('reconnecting-websocket');
const url = require('node:url');
const path = require('node:path');

const events = require('events');

//Use nodejs built-in crypto for uuid
const crypto = require('crypto');

//const Logger = require('./utils/logdata');
const debug = require('debug')('anl:ocpp2:cs');

const EventEmitter = events.EventEmitter;
const REQEVTPOSTFIX = '::REQUEST';
const CBIDCONPOSTFIX = '::CONNECTED';

const msgTypeStr = ['unknown', 'unknown', 'received', 'replied', 'error'];

const msgType = 0;
const msgId = 1;
const msgAction = 2;
const msgRequestPayload = 3;
const msgResponsePayload = 2;

const REQUEST = 2;
const RESPONSE = 3;
const CALLERROR = 4;
const CONTROL = 99;

let NetStatus = 'OFFLINE';

const cmdIdMap = new Map();


module.exports = function(RED) {
  function OcppChargeStationNode(config){
    RED.nodes.createNode(this, config);
    let hPingTimer = null;

    // Copy in the config values
    // 
    this.cbId = config.cbId;
    this.csms_url = config.csms_url;
    // TODO: csms users is required to be same as cbId
    // TODO: cmsm_pw should be CS specific
    // TODO: need to support updating pw from input
    this.csms_user = config.csms_user;
    this.csms_pw = config.csms_pw;
    this.messageTimeout = config.messageTimeout || 10000;
    this.auto_connect = config.auto_connect;

    const node = this;

    node.status({ fill: 'blue', shape: 'ring', text: 'OCPP CS 2.0.1' });

    const csmsURL = new URL(node.csms_url);

    csmsURL.protocol = 'ws';
    csmsURL.username = node.csms_user;
    csmsURL.password = node.csms_pw;
    csmsURL.pathname = path.join(csmsURL.pathname,node.cbId);
    debug(csmsURL.href);
    
    const options = {
      WebSocket: Websocket, // custom WebSocket constructor
      connectionTimeout: 1000,
      handshaketimeout: 5000,
      startClosed: (node.auto_connect == false),
      //maxRetries: 10,  //default to infinite retries
    };

    let ws = new ReconnectingWebSocket(() => csmsURL.href, ['ocpp2.0.1'], options);

    ws.addEventListener('open', function(){
      let msg = {};
      msg.ocpp = {};
      msg.payload = {};
      node.status({fill: 'green', shape: 'dot', text: 'Connected...'});
      node.wsconnected = true;
      msg.ocpp.websocket = 'ONLINE';
      if (NetStatus != msg.ocpp.websocket) {
        // node.send(msg);//send update
        NetStatus = msg.ocpp.websocket;
      }

      // Add a ping intervale timer
      // Need to call websocket property of websockets-reconnect ( stored as _ws )
      hPingTimer = setInterval(() => { ws._ws.ping(); }, 30000);
    });


    ws.addEventListener('close', function(code, reason){
      let msg = {};
      msg.ocpp = {};
      msg.payload = {};
      //logger.log('info', `Closing websocket connection to ${csms_url}`);
      debug('Websocket closed: code ', {code});
      debug('Websocket closed: reason ', {reason});
      node.status({fill: 'red', shape: 'dot', text: 'Closed...'});
      node.wsconnected = false;
      msg.ocpp.websocket = 'OFFLINE';
      if (NetStatus != msg.ocpp.websocket) {
        // node.send(msg);//send update
        NetStatus = msg.ocpp.websocket;
      }
      // Stop the ping timer
      if (hPingTimer != null){
        clearInterval(hPingTimer);
        hPingTimer = null;
      }

    });

    ws.addEventListener('error', function(err){
      node.log('Websocket error:', {err});
      debug('Websocket error:', {err});
    });

    ws.addEventListener('message', function(event) {
      let msgIn = event.data;
      let cbId = node.cbId;
      debug(`Got a message from CSMS: ${msgIn}`);
      // let ocpp2 = JSON.parse(msgIn);
      //
      let ocpp2;

      //////////////////////////////
      // This should never happen //
      // ..but I've seen EVSEs    //
      // do it..                  //
      /////////////////////////////
      if (msgIn[0] != '[') {
        ocpp2 = JSON.parse('[' + msgIn + ']');
      } else {
        ocpp2 = JSON.parse(msgIn);
      }

      let msgTypeStr = ['Request','Response','Error'][ocpp2[msgType]-2];

      // REQUEST, RESPONSE, or ERROR?
      //
      if (ocpp2[msgType] == REQUEST || ocpp2[msgType] == RESPONSE){
        let msg = {};
        msg.ocpp = {};
        msg.payload = {};

        msg.ocpp.ocppVersion = '2.0.1';

        switch (ocpp2[msgType]){
          case REQUEST:
            msg.payload.data = ocpp2[msgRequestPayload] || {}; 
            msg.payload.command = ocpp2[msgAction] || null; 
            msg.payload.MessageId = ocpp2[msgId];
            msg.ocpp.MessageId = ocpp2[msgId];
            let id = ocpp2[msgId];
            cmdIdMap.set(id, { cbId: msg.payload.cbId, command: ocpp2[msgAction], time: new Date() });
            setTimeout( function(){
              if (cmdIdMap.has(id)){
                let expCmd = cmdIdMap.get(id);
                debug(`Expired Req: id: ${id}, cbId: ${expCmd.cbId} cmd: ${expCmd.command}`);
                cmdIdMap.delete(id);
              }
            }, node.messageTimeout,id);
            break;
          case RESPONSE:
            msg.payload.data = ocpp2[msgResponsePayload] || {};
            if (cmdIdMap.has(ocpp2[msgId])){
              let c = cmdIdMap.get(ocpp2[msgId]);

              msg.payload.command = c.command;
              if (c.hasOwnProperty('_linkSource')){
                msg._linkSource = c._linkSource; 
              }
              cmdIdMap.delete(ocpp2[msgId]);
            } else {
              let errMsg = `Expired or invalid RESPONSE: ${ocpp2[msgId]}`;
              debug(errMsg);
              node.error(errMsg);
              return;
            }
            break;
        }

        msg.topic = `${cbId}/${msgTypeStr}`;
        //debug(msg.topic);

        msg.ocpp.command = msg.payload.command;
        msg.ocpp.cbId = cbId;

        // Check valididty of the command schema
        //
        let schemaName = `${msg.payload.command}${msgTypeStr}.json`;

        //debug(`COMMAND SCHEMA: ${schemaName}`);

        let schemaPath = path.join(__dirname, 'schemas', schemaName)

        // By first checking if the file exists, we check that the command is an
        // acutal ocpp2.0.1 command
        if (fs.existsSync(schemaPath)){
          let schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

          let val = schema_val.validate(ocpp2[msgRequestPayload],schema);

          if (val.errors.length > 0) {
            let invalidOcpp2 = val.errors;
            done(invalidOcpp2);
            node.error({invalidOcpp2});
            return;
          }
        } else {
          let errMsg = `Invalid OCPP2.0.1 command: ${ocpp2[msgAction]}`;
          node.error(errMsg);
          done(errMsg);
          return;
        }

        msg.hasOwnProperty('_linkSource') ? node.send(null,msg) : node.send(msg,null);
      }

    });

    ////////////////////////////////////////////
    // This section is for input from a the   //
    // Node itself                            //
    ////////////////////////////////////////////
    
    node.on('input', function(msg, send, done){

      let ocpp2 = [];

      debug(JSON.stringify(msg));

      ocpp2[msgType] = msg.payload.msgType || REQUEST;
      ocpp2[msgId] = msg.payload.MessageId || crypto.randomUUID();

      if (ocpp2[msgType] == CONTROL){

        ocpp2[msgAction] = msg.payload.command || node.command;

        if (!ocpp2[msgAction]){
          const errStr = 'ERROR: Missing Control Command in JSON request message';
          node.error(errStr);
          debug(errStr);
          return;
        }

        switch (ocpp2[msgAction].toLowerCase()){
          case 'connect':
            if (msg.payload.data && msg.payload.data.hasOwnProperty('cbId')){
              this.cbId = msg.payload.data.cbId;
            }
            if (msg.payload.data && msg.payload.data.hasOwnProperty('csmsUrl')){
              this.csms_url = msg.payload.data.csmsUrl.endsWith('/') ? msg.payload.data.csmsUrl.slice(0, -1) : msg.payload.data.csmsUrl;
            }
            ws.reconnect();
            break;
          case 'close':
            ws.close();
            break;
          default:
            break;
        }
        //logger.log(msgTypeStr[request[msgType]], JSON.stringify(request).replace(/,/g, ', '));
      } else if ( node.wsconnected == true){
        if (ocpp2[msgType] == REQUEST){
          ocpp2[msgAction] = msg.payload.command || null;
          ocpp2[msgRequestPayload] = msg.payload.data || {};
          ocpp2[msgId] = msg.payload.MessageId || crypto.randomUUID();

          // Check for missing command in object
          if (!ocpp2[msgAction]){
            const errStr = 'ERROR: Missing Command in JSON request message';
            node.error(errStr);
            done(errStr);
            return;
          }

          // Check valididty of the command schema
          //
          let schemaName = `${ocpp2[msgAction]}Request.json`;

          let schemaPath = path.join(__dirname, 'schemas', schemaName)

          // By first checking if the file exists, we check that the command is an
          // acutal ocpp2.0.1 command
          if (fs.existsSync(schemaPath)){
            let schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

            let val = schema_val.validate(ocpp2[msgRequestPayload],schema);

            if (val.errors.length > 0) {
              let invalidOcpp2 = val.errors;
              done(invalidOcpp2);
              node.error({invalidOcpp2});
              return;
            }
          } else {
            let errMsg = `Invalid OCPP2.0.1 command: ${ocpp2[msgAction]}`;
            node.error(errMsg);
            done(errMsg);
            return;
          }

          ocpp2[msgAction] = msg.payload.command; // || node.command;


          ocpp2[msgRequestPayload] = msg.payload.data || {}; // cmddata || {};
          if (!ocpp2[msgRequestPayload]){
            const errStr = 'ERROR: Missing Data in JSON request message';
            node.error(errStr);
            done(errStr);
            debug(errStr);
            return;
          }

          let id = ocpp2[msgId];
          let c = {
            cbId: msg.payload.cbId, 
            command: ocpp2[msgAction], 
            time: new Date()
          };

          // Save the return link node path if it exists
          if (msg.hasOwnProperty('_linkSource')){
            c._linkSource = JSON.parse(JSON.stringify(msg._linkSource));
          }

          cmdIdMap.set(id, c);
          setTimeout( function(){
            if (cmdIdMap.has(id)){
              let expCmd = cmdIdMap.get(id);
              debug(`Expired Req: id: ${id}, cbId: ${expCmd.cbId} cmd: ${expCmd.command}`);
              cmdIdMap.delete(id);
            }
          }, node.messageTimeout,id);

          let ocpp_msg = JSON.stringify(ocpp2);
          debug(`Sending message: ${ocpp_msg}`);
          ws.send(ocpp_msg);
          node.status({fill: 'green', shape: 'dot', text: `REQ out: ${ocpp2[msgAction]}`});
          
        } else { // Assuming the call is a RESPONSE to an existing REQUEST
          ocpp2[msgResponsePayload] = msg.payload.data || {};
          ocpp2[msgId] = msg.ocpp.MessageId;


          if (cmdIdMap.has(ocpp2[msgId])){

            let cbId = cmdIdMap.get(ocpp2[msgId]).cbId;

            // Check valididty of the command schema
            //
            let msgAction = cmdIdMap.get(ocpp2[msgId]).command;
            let schemaName = `${msgAction}Response.json`;

            let schemaPath = path.join(__dirname, 'schemas', schemaName)

            // By first checking if the file exists, we check that the command is an
            // acutal ocpp2.0.1 command
            if (fs.existsSync(schemaPath)){
              let schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

              let val = schema_val.validate(ocpp2[msgResponsePayload],schema);

              if (val.errors.length > 0) {
                //val.errors.forEach( (x) => { node.error({x}) });
                let invalidOcpp2 = val.errors;
                done(invalidOcpp2);
                node.error({invalidOcpp2});
                return;
              }

            } else {
              let errMsg = `Invalid OCPP2.0.1 command: ${msgAction}`;
              node.error(errMsg);
              done(errMsg);
              return;
            }


          }else{
            let msgError = `Target message Id is missing or expired: ${ocpp2[msgId]}`;
            node.error(msgError);
            done(msgError);
            return;
          }


          let ocpp_msg = JSON.stringify(ocpp2);
          debug(`Sending message: ${ocpp_msg}`);
          ws.send(ocpp_msg,ocpp_msg);
          node.status({fill: 'green', shape: 'dot', text: `RES out: ${msgAction}`});
        }
      }
    });
  }

  RED.nodes.registerType('CS', OcppChargeStationNode);
}
