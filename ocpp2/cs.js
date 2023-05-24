/* CS: Charging Station

  Title: Node-Red-Contrib-OCPP2
  Author: Bryan Nystrom
  Company: Argonne National Laborator

  File: cs.js
  Description: CS (Charge Station) node.

*/ 

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


//Use nodejs built-in crypto for uuid
const crypto = require('crypto');

//const Logger = require('./utils/logdata');
const debug = require('debug')('anl:ocpp2:cs');

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

const WSTOMIN_DEF = 5;
const WSTOMAX_DEF = 360;
const WSTOINC_DEF = 5;

const OCPPPROTOCOL = ['ocpp2.0.1'];

let NetStatus = 'OFFLINE';

const cmdIdMap = new Map();


module.exports = function(RED) {
  function OcppChargeStationNode(config){
    RED.nodes.createNode(this, config);
    let hPingTimer = null;

    // Copy in the config values
    // 
    this.cbId = config.cbId;
    this.csms = RED.nodes.getNode(config.csms);
    this.csms_url = this.csms.url;
    // TODO: csms users is required to be same as cbId
    // TODO: cmsm_pw should be CS specific
    // TODO: need to support updating pw from input
    // this.csms_user = config.csms_user;
    this.csms_user = this.cbId;
    this.csms_pw = this.credentials.csms_pw;
    this.messageTimeout = config.messageTimeout || 10000;
    this.auto_connect = config.auto_connect;

    this.wstomin = (isNaN(Number.parseInt(config.wstomin))) ? WSTOMIN_DEF : Number.parseInt(config.wstomin);
    let _wstomax = (isNaN(Number.parseInt(config.wstomax))) ? WSTOMAX_DEF : Number.parseInt(config.wstomax);
    this.wstomax = parseInt((_wstomax >= this.wstomin)? _wstomax : this.wstomin);
    this.wstoinc = (isNaN(Number.parseInt(config.wstoinc))) ? WSTOINC_DEF : Number.parseInt(config.wstoinc);

    const node = this;

    node.status({ fill: 'blue', shape: 'ring', text: 'OCPP CS 2.0.1' });

    let csmsURL;
    let ws;
    let wsreconncnt = 0;
    let wstocur = parseInt(node.wstomin);
    let conto;
    let wsnoreconn = false;

    try {
      csmsURL = new URL(node.csms_url);
    }catch(error){
      node.status({ fill: 'red', shape: 'ring', text: error });
      debug(`URL error: ${error}`);
      return;
    }

    csmsURL.protocol = 'ws';
    csmsURL.username = node.csms_user;
    csmsURL.password = node.csms_pw;
    csmsURL.pathname = path.join(csmsURL.pathname,node.cbId);
    debug(csmsURL.href);
    

    const ws_options = {
      handshaketimeout: 5000,
      connectTimeout: 5000
    };

    function reconn_debug() {
      debug(`wstomin: ${node.wstomin}`);
      debug(`wstomax: ${node.wstomax}`);
      debug(`wstoinc: ${node.wstoinc}`);
      debug(`wstocur: ${wstocur}`);
      debug(`wsreconncnt: ${wsreconncnt}`);
    }; 


    let ws_open = function(){
      let msg = {};
      msg.ocpp = {};
      wsreconncnt = 0;
      wstocur = parseInt(node.wstomin);
      node.status({fill: 'green', shape: 'dot', text: 'Connected...'});
      node.wsconnected = true;
      wsreconncnt = 0;
      wstocur = node.wstomin;
      msg.ocpp.websocket = 'ONLINE';
      if (NetStatus != msg.ocpp.websocket) {
        node.send(msg);//send update
        NetStatus = msg.ocpp.websocket;
      }

      // Add a ping intervale timer
      hPingTimer = setInterval(() => { ws.ping(); }, 30000);
    };


    let ws_close = function(code, reason){
      let msg = {};
      msg.ocpp = {};
      debug(`Websocket closed code: ${code.code}`);
      // debug(`Websocket closed reason: ${reason}`);
      node.status({fill: 'red', shape: 'dot', text: 'Closed'});
      node.wsconnected = false;
      msg.ocpp.websocket = 'OFFLINE';
      if (NetStatus != msg.ocpp.websocket) {
        node.send(msg);//send update
        NetStatus = msg.ocpp.websocket;
      }
      // Stop the ping timer
      if (hPingTimer != null){
        clearInterval(hPingTimer);
        hPingTimer = null;
      }

      // remove all the events from the ws object
      ws.removeEventListener('open',ws_open);
      ws.removeEventListener('close',ws_close);
      ws.removeEventListener('error',ws_error);
      ws.removeEventListener('message',ws_message);
      
      if (!wsnoreconn){
        // Inc the reconnection try count
        wsreconncnt += 1;
        node.status({fill: 'red', shape: 'dot', text: `(${wsreconncnt}) Reconnecting `});
        conto = setTimeout( () => ws_connect(), wstocur * 1000);
        debug(`ws reconnect timeout: ${wstocur}`);
        // adjust the timeout value for the next round
        wstocur += +node.wstoinc;
        wstocur = (wstocur >= node.wstomax) ? node.wstomax : wstocur; 
      } else {
        node.status({fill: 'red', shape: 'dot', text: `Closed`});
      };
      
    };

    let ws_error = function(err){
      node.log('Websocket error:', {err});
      // debug('Websocket error:', {err});
    };

    let ws_message = function(event) {
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

    };
    
    function ws_connect(){
      reconn_debug();
      try {
        ws = new Websocket(csmsURL.href, OCPPPROTOCOL, ws_options);
        ws.timeout = 5000;
        debug(`${node.cbId} ws_connect()`);
        ws.addEventListener('open',ws_open);
        ws.addEventListener('close',ws_close);
        ws.addEventListener('error',ws_error);
        ws.addEventListener('message',ws_message);
      }catch(error){
        debug(`Websocket Error: ${error}`);
        return;
      }
    };

    function ws_reconnect(){
      debug('Clearing Timeout');
      clearTimeout(conto);
      try {
        if (ws){
          ws.removeEventListener('open',ws_open);
          ws.removeEventListener('close',ws_close);
          ws.removeEventListener('error',ws_error);
          ws.removeEventListener('message',ws_message);
          ws.close();
        }
        clearTimeout(conto);
        ws_connect();
      }catch(error){
        debug(`Websocket Error: ${error}`);
        return;
      }
    };

    // Only do this if auto-connect is enabled
    // 
    if (node.auto_connect && csmsURL){
      node.status({fill: 'blue', shape: 'dot', text: `Connecting...`});
      ws_connect();
    }

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
            clearTimeout(conto);
            if (msg.payload.data && msg.payload.data.hasOwnProperty('cbId')){
              this.cbId = msg.payload.data.cbId;
            }
            if (msg.payload.data && msg.payload.data.hasOwnProperty('password')){
              this.csms_pw = msg.payload.data.password;
            }
            if (msg.payload.data && msg.payload.data.hasOwnProperty('csmsUrl')){
              this.csms_url = msg.payload.data.csmsUrl.endsWith('/') ? msg.payload.data.csmsUrl.slice(0, -1) : msg.payload.data.csmsUrl;
            }
            try {
              csmsURL.href = node.csms_url;
              csmsURL.protocol = 'ws';
              // csmsURL.username = node.csms_user;
              csmsURL.username = node.cbId;
              csmsURL.password = node.csms_pw;
              csmsURL.pathname = path.join(csmsURL.pathname,node.cbId);
              debug(csmsURL.href);
            }catch(error){
              node.status({ fill: 'red', shape: 'ring', text: error });
              debug(`URL error: ${error}`);
              return;
            }
            wsnoreconn = false;
            ws_reconnect();
            break;
          case 'close':
            wsnoreconn = true;
            if(ws){
              clearTimeout(conto);
              ws.close();
              node.status({fill: 'red', shape: 'dot', text: 'Closed'});
            }
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

  RED.nodes.registerType('CS', OcppChargeStationNode, {
    credentials: {
      csms_pw: {type: 'password'}
    }
  });
  
/***********************************************************************
  * THis sets up the configuration node for target CSMSs
  *
***********************************************************************/

  function CSMSConfigNode(n) {
    RED.nodes.createNode(this, n);
    this.url = n.url;
    this.name = n.name || n.url;
    }

    RED.nodes.registerType('target-csms', CSMSConfigNode);
}
    
