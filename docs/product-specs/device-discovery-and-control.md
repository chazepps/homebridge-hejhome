# Device Discovery and Control Spec

## Goal

Expose supported Hejhome devices to HomeKit through Homebridge services.

## Discovery

The platform loads a stored session, fetches families, fetches devices per family, and creates stable Homebridge accessories from device ids.

## Control

Switch-like devices use the HomeKit `On` characteristic. The cloud control client submits the detected power datapoint and updates local state after the request resolves.

## Conservative Mapping

Unknown device classes are mapped as switches until a verified capability map exists. This avoids exposing unsupported HomeKit characteristics.
