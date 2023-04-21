# TODO list for Node-Red OCPP 2.0.1

## CS
- [x] Make CSMS_URL a configuration node
- [x] Remove Authentication username
  - [x] default basic auth username to cbId
- [x] Save auth password in credentials
- [] Usage Docs
- [] Config help

## CSMS
- [x] Add multi-line text config for auth
- [x] Save auth in credentials?
- [x] Change basic auth to support multi accounts
- [] Usage Docs
- [] Config help

## Non OPCC2.0.1 node-red node tasks

This is a list of items that are not part of the actual OCPP2.0.1 nodes. Mainly they are node-red
flows that demonstrate the useage of the CS and CSMS nodes. Some may be targeted to be added 
as example flows. Others specific to ANL needs.

- [] Demo of getting / setting variables
  - [] Demo of getting /setting HeartbeatInterval from CSMS
  - [] Demo of setting and using HeartbeatInterval on CS

- [] Demo of "Notification" abilities
  - [] Demo of requesting each type of notification from CSMS
  - [] Demo of providing notification of each type from CS
