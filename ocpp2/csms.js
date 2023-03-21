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
const events = require('events');
//const { v4: uuidv4 } = require('uuid');
//
//Use nodejs built-in crypto for uuid
const crypto = require('crypto');


const proc = require('node:process');

//const Logger = require('./utils/logdata');
const debug_csms = require('debug')('anl:ocpp2:csms');
const debug_csresponse = require('debug')('anl:ocpp2:cs:response');
const debug_csrequest = require('debug')('anl:ocpp2:cs:request:json');

const EventEmitter = events.EventEmitter;
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
    const node = this;
    let msg = {};
    node.status({ fill: 'blue', shape: 'ring', text: 'CSMS 2.0.1' });
    debug_csms('Starting OCPP2.0.1 CSMS');

    let connMap = new Map();

    node.port = config.port;
    node.path = config.path;
    node.ws_user = config.ws_user;
    node.ws_pw = config.ws_pw;

    const wspath = `${node.path}/:cbid`;

    const expressServer = express();

    // TODO: Should support a p/w for each CS.
    // TODO: Option to use single p/w signon:
    var users = {};
    users[node.ws_user] = node.ws_pw;
    expressServer.use( basicAuth({
      users
    }));
    
    // This checks that the subprotocol header for websockets is set to 'ocpp2.0.1'
    const wsOptions = {
      handleProtocols: function(protocols, request) {
        const requiredSubProto = 'ocpp2.0.1';
        debug_csms(`SubProtocols: [${protocols}]`);
        return protocols.includes(requiredSubProto) ? requiredSubProto : false;
      },
    };

    const expressWs = expressws(expressServer, null, { wsOptions });
    //const expressWs = expressws(expressServer);


    const server = expressServer.listen(node.port, function() {
      expressServer.ws(wspath, function(ws, req, next) {
        let cbid = req.params.cbid;

        connMap.set(cbid, { since: new Date() });
        debug_csms(`Message from ${cbid}`);
        let cnt = connMap.size;
        node.status({ fill: 'green', shape: 'ring', text: `(${cnt})` });

      ws.on('open', function() {
        debug_csms(`Got an ws.open for ${cbid}`);
        });
      ws.on('close', function() {
        debug_csms(`Got an ws.close for ${cbid}`);
        connMap.delete(cbid)
        let cnt = connMap.size;
        node.status({ fill: 'green', shape: 'ring', text: `(${cnt})` });
        });
      ws.on('error', function() {
        debug_csms(`Got an ws.error for ${cbid}`);
        });

      });


    });
    node.on('input', function(msg,send,done) {
      debug_csms(msg.payload);

      let ocpp2 = [];

      debug_csms(JSON.stringify(msg));

      debug_csms(connMap.has('CS1'));

      ocpp2[msgType] = msg.payload.msgType || REQUEST;
      ocpp2[msgId] = msg.payload.MessageId || crypto.randomUUID();

      if (ocpp2[msgType] == CONTROL){

        ocpp2[msgAction] = msg.payload.command || node.command;

        if (!ocpp2[msgAction]){
          const errStr = 'ERROR: Missing Control Command in JSON request message';
          debug_csms(errStr);
          node.error(errStr);
          done(errStr);
          return;
        }

        switch (ocpp2[msgAction].toLowerCase()){
          case 'connections':
            let connections = connMap;

            msg.payload = { connections };

            send(msg);
            done();
            break;
          case 'ws_close':
            done();
            break;
          case 'ws_open':
            done();
            break;
          default:
            done('Valid commands are "connections", "ws_close", and "ws_open"');
            break;
        }
        //logger.log(msgTypeStr[request[msgType]], JSON.stringify(request).replace(/,/g, ', '));
//      } else if ( node.wsconnected == true){
      } else if ( connMap.has(msg.payload.cbId)){
        if (ocpp2[msgType] == REQUEST){
          ocpp2[msgAction] = msg.payload.command || null;
          ocpp2[msgRequestPayload] = msg.payload.data || {};

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
            debug_csms('Should Not Get Here');
            let schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

            let val = schema_val.validate(ocpp2[msgRequestPayload],schema);

            if (val.errors.length > 0) {
              //val.errors.forEach( (x) => { node.error({x}) });
              let invalidOcpp2 = val.errors;
              done(invalidOcpp2);
              node.error({invalidOcpp2});
              //done(`OCPP Validation Errors: ${val.errors}`);
              return;
            }
            debug_csms('SHOULD NOT REACH HERE');

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

          ocpp2[msgRequestPayload] = msg.payload.data || cmddata || {};
          if (!ocpp2[msgRequestPayload]){
            const errStr = 'ERROR: Missing Data in JSON request message';
            node.error(errStr);
            debug_csms(errStr);
            return;
          }

          let id = request[msgId];
          cmdIdMap.set(id) = ocpp2[msgAction];
          setTimeout( function(id){
            if (cmdIdMap.has(id)){
              let expCmd = cmdIdMap.get(id);
              debug_csms(`Expired Message Req: id:${id}, cmd:${expCmd}`);
              cmdIdMap.delete(id);
            }
          }, node.messageTimout);

          debug_csms(`Sending message: ${ocpp2[msgAction]}, ${request}`);
          node.status({fill: 'green', shape: 'dot', text: `request out: ${ocpp2[msgAction]}`});
          
        } else {
          ocpp2[msgResponsePayload] = msg.payload.data || {};
          ocpp2[msgId] = msg.ocpp.MessageId;


          if (cmdIdMap.has(ocpp2[msgId]){
            
            // Check valididty of the command schema
            //
            let msgAction = cmdIdMap.get(ocpp2[msgId]);
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
                //done(`OCPP Validation Errors: ${val.errors}`);
                return;
              }
              debug_csms('SHOULD NOT REACH HERE');

            } else {
              let errMsg = `Invalid OCPP2.0.1 command: ${ocpp2[msgAction]}`;
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


          debug_csms(`Sending response message: ${JSON.stringify(ocpp2[msgResonsePayload])}`);
          node.status({fill: 'green', shape: 'dot', text: 'sending response'});
        }
      }
    });

    node.on('close', function() {
      // need to close the server upon NR (re)deploy or it won't release the ws port
      //
      server.close();
    });
  }

  RED.nodes.registerType('CSMS', OcppCsmsNode);
}
