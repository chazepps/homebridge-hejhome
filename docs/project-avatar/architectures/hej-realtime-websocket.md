# Hej Realtime WebSocket

## Current Transport

The realtime client uses MQTT over WebSocket and subscribes to a user-specific topic derived from the encoded session identifier.

## Message Handling

Incoming status reports are reduced into device state patches, then routed to the matching cached accessory by stable device id.

## Evidence Standard

New realtime fields must be added only after an authenticated browser session capture is reviewed and redacted. Raw packets must not be committed.
