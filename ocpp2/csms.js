// CSMS
//

'use strict';


const express = require('express');
const expressws = require('express-ws');
const basicAuth = require('express-basic-auth');

// This will validate incoming and outgoing ocpp2.0.1 messages
// for proper format
const Validator = require('jsonschema').Validator;
const schema_val = new Validator();
// we need fs for reading the validation schema and logging
const fs = require('node:fs');
const path = require('path');
// const events = require('events');

//Use nodejs built-in crypto for uuid
const crypto = require('crypto');


const proc = require('node:process');

//const Logger = require('./utils/logdata');
const debug = require('debug')('anl:ocpp2:csms');

const REQEVTPOSTFIX = '::REQUEST';
const CBIDCONPOSTFIX = '::CONNECTED';

const msgType = 0;
const msgId = 1;
const msgAction = 2;
const msgRequestPayload = 3;
const msgResponsePayload = 2;

const REQUEST = 2;
const RESPONSE = 3;
const CALLERROR = 4;
const CONTROL = 99;

module.exports = function(RED) {
  function OcppCsmsNode(config){
    RED.nodes.createNode(this, config);
    let msg = {};

    let connMap = new Map();

    const cmdIdMap = new Map();

    this.port = config.port;
    this.path = config.path;
    this.ws_user = config.ws_user;
    this.ws_pw = config.ws_pw;
    this.messageTimeout = config.messageTimeout || 10000;

    this.basic_auths = this.credentials.basic_auths;

    const node = this;

    const wspath = `${node.path}/:cbId`;

    const expressServer = express();

    node.status({ fill: 'blue', shape: 'ring', text: 'CSMS 2.0.1' });
    debug('Starting OCPP2.0.1 CSMS');
    // TODO: Should support a p/w for each CS.
    // TODO: Option to use single p/w signon:
    //
    var users = JSON.parse(this.basic_auths);
    
    debug(`Basic Auth: ${users.BadTaco}`);
    // users[node.ws_user] = node.ws_pw;

    expressServer.use( basicAuth({
      users: users
    }));

    // This checks that the subprotocol header for websockets is set to 'ocpp2.0.1'
    const wsOptions = {
      handleProtocols: function(protocols, request) {
        const requiredSubProto = 'ocpp2.0.1';
        debug(`SubProtocols: [${protocols}]`);
        return protocols.includes(requiredSubProto) ? requiredSubProto : false;
      },
    };

    const expressWs = expressws(expressServer, null, { wsOptions });
    //const expressWs = expressws(expressServer);


    const server = expressServer.listen(node.port, function() {
      expressServer.ws(wspath, function(ws, req, next) {
        let cbId = req.params.cbId;

        connMap.set(cbId, { since: new Date(), ws });
        debug(`Message from ${cbId}`);
        let cnt = connMap.size;
        node.status({ fill: 'green', shape: 'ring', text: `(${cnt})` });

        ws.on('open', function() {
          debug(`Got an ws.open for ${cbId}`);
        });
        ws.on('close', function() {
          debug(`Got an ws.close for ${cbId}`);
          connMap.delete(cbId)
          let cnt = connMap.size;
          node.status({ fill: 'green', shape: 'ring', text: `(${cnt})` });
        });
        ws.on('error', function() {
          debug(`Got an ws.error for ${cbId}`);
        });

        ws.on('message', function(msgIn){
          debug(`Get a message from ${cbId}: ${msgIn}`);
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
            debug(msg.topic);

            msg.ocpp.command = msg.payload.command;
            msg.ocpp.cbId = cbId;

            // Check valididty of the command schema
            //
            let schemaName = `${msg.payload.command}${msgTypeStr}.json`;

            // debug(`COMMAND SCHEMA: ${schemaName}`);

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

        next();
      });


    });

    ////////////////////////////////////////////
    // This section is for input from a the   //
    // Node itself                            //
    ////////////////////////////////////////////

    node.on('input', function(msg,send,done) {
      //debug(msg.payload);

      let ocpp2 = [];

      if (!msg.hasOwnProperty('payload')){
        let err_msg = 'Message is missing payload';
        node.error(err_msg);
        done(err_msg);
        return;
      }

      if (!msg.payload.hasOwnProperty('cbId')){
        if (msg.hasOwnProperty('ocpp') && msg.ocpp.hasOwnProperty('cbId')){
          msg.payload.cbId = msg.ocpp.cbId;
        }else{
          msg.payload.cbId = '';
        }
      }
      let cbId = msg.payload.cbId;

      debug(JSON.stringify(msg));

      ocpp2[msgType] = msg.payload.msgType || REQUEST;
      ocpp2[msgId] = msg.payload.MessageId || crypto.randomUUID();

      // CONTROL type are for node internal commands not destine for 
      // a websocket call to a Charging Station (CS)
      // ///////////////////////////////////////////////////////////

      if (ocpp2[msgType] == CONTROL){

        ocpp2[msgAction] = msg.payload.command || null; // || node.command;

        if (!ocpp2[msgAction]){
          const errStr = 'ERROR: Missing Control Command in JSON request message';
          debug(errStr);
          node.error(errStr);
          done(errStr);
          return;
        }

        switch (ocpp2[msgAction].toLowerCase()){
          case 'connections':
            let connections = connMap;

            msg.payload = { connections };

            msg.hasOwnProperty('_linkSource') ? node.send(null,msg) : node.send(msg,null);
            done();
            break;
          case 'cmds':
            let commands = cmdIdMap;
            msg.payload = { commands };
            msg.hasOwnProperty('_linkSource') ? node.send(null,msg) : node.send(msg,null);
            done();
            break;
          case 'ws_close':
            msg.payload = "Sorry, not implemented yet";
            msg.hasOwnProperty('_linkSource') ? node.send(null,msg) : node.send(msg,null);
            done();
            break;
          case 'ws_open':
            msg.payload = "Sorry, not implemented yet";
            msg.hasOwnProperty('_linkSource') ? node.send(null,msg) : node.send(msg,null);
            done();
            break;
          default:
            done('Valid commands are "connections", "cmds", "ws_close", and "ws_open"');
            break;
        }
        //logger.log(msgTypeStr[request[msgType]], JSON.stringify(request).replace(/,/g, ', '));
        //      } else if ( node.wsconnected == true){

        // Only "send" if the websocket is assigned to the chargeBoxId cbId
        //
      } else if (connMap.has(msg.payload.cbId)){
        // Not able to locate this cbId in the connection map
        // This section will make a request call to a CS
        //


        // get the websocket of this connection
        let cb_ws = connMap.get(msg.payload.cbId).ws;

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

          //          let cmddata;
          //          if (node.cmddata){
          //            try {
          //              cmddata = JSON.parse(node.cmddata);
          //            } catch (e){
          //              node.warn('OCPP JSON client node invalid payload.data for message (' + msg.ocpp.command + '): ' + e.message);
          //              return;
          //            }
          //          }

          ocpp2[msgRequestPayload] = msg.payload.data || {}; // cmddata || {};
          if (!ocpp2[msgRequestPayload]){
            const errStr = 'ERROR: Missing Data in JSON request message';
            node.error(errStr);
            done(errStr);
            debug(errStr);
            return;
          }

          let id = ocpp2[msgId];

          let cmdInfo = {
            cbId: msg.payload.cbId, 
            command: ocpp2[msgAction], 
            time: new Date()
          };

        // Save the return link node path if it exists
          if (msg.hasOwnProperty('_linkSource')){
            cmdInfo._linkSource = JSON.parse(JSON.stringify(msg._linkSource));
          }

          cmdIdMap.set(id, cmdInfo);



          setTimeout( function(){
            if (cmdIdMap.has(id)){
              let expCmd = cmdIdMap.get(id);
              debug(`Expired Req: id: ${id}, cbId: ${expCmd.cbId} cmd: ${expCmd.command}`);
              cmdIdMap.delete(id);
            }
          }, node.messageTimeout,id);

          let ocpp_msg = JSON.stringify(ocpp2);
          debug(`Sending message: ${ocpp_msg}`);
          cb_ws.send(ocpp_msg);
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

            cmdIdMap.delete(ocpp2[msgId]);

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
                //done(`OCPP Validation Errors: ${val.errors}`);
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
          cb_ws.send(ocpp_msg);
          node.status({fill: 'green', shape: 'dot', text: `RES out: ${msgAction}`});
        }
      } else {
        // Not able to locate this cbId in the connection map
        let err_msg = `ChargeBoxId "${cbId}" is not connected`;
        node.error(err_msg);
        done(err_msg);
      }
    });

    node.on('close', function() {
      // need to close the server upon NR (re)deploy or it won't release the ws port
      //
      server.close();
    });
  }

  RED.nodes.registerType('CSMS', OcppCsmsNode, { 
    credentials: { basic_auths: { type: 'json' } }
  });
}
