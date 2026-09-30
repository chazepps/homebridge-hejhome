/** Normalized actuator, event and sensor fields cannot be repurposed as electrical meter sources. */
const RESERVED_FIELDS = new Set([
  'brightness', 'lightMode', 'hsvColor', 'sceneValues', 'temperature', 'humidity', 'pm25',
  'battery', 'motionDetected', 'lastMotionAt', 'state', 'doorOpened', 'alarm', 'alarmSwitch',
  'percentState', 'percentControl', 'control', 'workState', 'fanSpeed', 'mode',
  'action', 'event', 'button', 'buttonEvent', 'gesture',
]);

export function isReservedMeasurementField(field: string): boolean {
  return /^power\d*$/.test(field) || RESERVED_FIELDS.has(field);
}
