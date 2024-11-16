import Bluebird from 'bluebird';
import deepmerge from 'deepmerge';
import { EventEmitter } from 'events';
import lodash from 'lodash';
import mqtt from 'paho-mqtt';
import ws from 'ws';

import { Base } from '../accessories/base.js';
import { EVENT_MOTION_DETECTED } from '../accessories/sensor_mo.js';
import { EVENT_BUTTON_PRESSED } from '../accessories/smart_button.js';
import { HejhomePlatform } from '../platform.js';
import { getDevices } from './get_devices.js';
import { getFamilies } from './get_family.js';
import { getRooms } from './get_rooms.js';
import { HEJ_CLIENT_ID, HEJ_CLIENT_SECRET } from './get_token.js';

const { Client } = mqtt;
const { differenceBy, get, set } = lodash;

(global as unknown as { WebSocket: typeof ws }).WebSocket = ws;

export const hejEvent = new EventEmitter();

type HejDevice = {
  id: string;
  roomId?: number;
  name: string;
  deviceType:
  | 'LightRgbw5'
  | 'ZigbeeSwitch1'
  | 'ZigbeeSwitch2'
  | 'IrFan'
  | 'IrTv'
  | 'SensorMo'
  | 'LedStripRgbw2'
  | 'SmartButton'
  | 'SensorTh'
  | 'RelayController';
  hasSubDevices: boolean;
  modelName: string | null;
  familyId: number;
  category: string;
  deviceState: {
    power?: boolean;
    lightMode?: 'WHITE' | 'COLOR' | 'SCENE';
    hsvColor?: {
      hue: number;
      saturation: number;
      brightness: number;
    };
    brightness?: number;
    sceneValues?: string;
    power1?: boolean;
    power2?: boolean;
    battery?: number;
    lastMotionAt?: number;
  } | null;
  online: boolean;
};

type HejFamilies = {
  [key: string]: {
    familyId: number;
    name: string;
    rooms: {
      [key: string]: {
        roomId: number;
        name: string;
        devices: HejDevice['id'][];
      };
    };
  };
};

export const hejAccessories: { [id: string]: Base } = {};
export const hejDevices: { [id: string]: HejDevice } = {};
const deviceOverrides: { [id: string]: Partial<HejDevice> } = {};
const families: HejFamilies = {};

const client = new Client('ws://mqtt.hej.so:15675/ws', '');

const loadSnapshot = async (platform: HejhomePlatform) => {
  const _families = await getFamilies(platform);

  await Bluebird.each(_families, async (family) => {
    set(families, `${family.familyId}`, {
      familyId: family.familyId,
      name: family.name,
      rooms: get(families, `${family.familyId}.rooms`, {}),
    });

    const _rooms = await getRooms(platform, family.familyId);
    const allDevices: HejDevice[] = (
      await getDevices(platform, family.familyId)
    ).map((i) => ({ ...i, deviceId: i.id }));

    allDevices.forEach((device) => {
      hejDevices[device.id] = device;
    });

    const roomAssignedDeviceIds: HejDevice['id'][] = [];

    await Bluebird.each(_rooms.rooms, async (room) => {
      set(families, `${family.familyId}.rooms.${room.room_id}`, {
        roomId: room.room_id,
        name: room.name,
        devices: [],
      });
      const _devices = await getDevices(
        platform,
        family.familyId,
        room.room_id,
      );

      await Bluebird.each(_devices, async (device) => {
        if (hejDevices[device.id]) {
          hejDevices[device.id].roomId = room.room_id;
        }

        roomAssignedDeviceIds.push(device.id);

        families[family.familyId].rooms[room.room_id].devices.push(device.id);
      });
    });

    const roomUnassignedDevices = differenceBy(
      allDevices.map((i) => i.id),
      roomAssignedDeviceIds,
    );

    families[family.familyId].rooms['-1'] = {
      roomId: -1,
      name: 'Unassigned',
      devices: roomUnassignedDevices,
    };
  });
};

export const startRealtime = async (platform: HejhomePlatform) => {
  try {
    client.disconnect();
  } catch (e) {
    // Handle error if needed
  }

  client.onConnectionLost = (e) => {
    platform.log.error('mqtt onConnectionLost', e);
  };

  client.onMessageArrived = (e) => {
    try {
      const data: {
        deviceDataReport?: {
          devId: string;
          status: (
            | {
              code: 'switch_led';
              value: boolean;
            }
            | {
              code: 'work_mode';
              value: 'white' | 'colour' | 'scene';
            }
            | {
              code: 'scene_data';
              value: string; // {"h":37.0,"s":3.1,"v":100.0}
            }
            | {
              code: 'colour_data';
              value: string; // {"h":261.0,"s":255.0,"v":255.0}
            }
            | {
              code: 'pir';
              value: 'none' | string;
            }
            | {
              code: 'bright_value';
              value: number;
            }
            | {
              code: 'switch_1';
              value: boolean;
            }
            | {
              code: 'switch_2';
              value: boolean;
            }
            | {
              code: 'switch1_value';
              value: 'single_click' | 'double_click';
            }
            | {
              code: 'switch2_value';
              value: 'single_click' | 'double_click';
            }
            | {
              code: 'switch3_value';
              value: 'single_click' | 'double_click';
            }
            | {
              code: 'switch4_value';
              value: 'single_click' | 'double_click';
            }
          )[];
        };
      } = JSON.parse(e.payloadString);

      const devId = data.deviceDataReport?.devId;

      data.deviceDataReport?.status?.map((i) => {
        platform.log.debug(`MQTT device event: ${i.code}@${data.deviceDataReport?.devId} ⇒ ${i.value}`);
      });

      if (data.deviceDataReport) {
        data.deviceDataReport.status.forEach((status) => {
          switch (status.code) {
            case 'switch_led':
              set(deviceOverrides, `${devId}.deviceState.power`, status.value);
              break;
            case 'work_mode':
              switch (status.value) {
                case 'white': {
                  set(deviceOverrides, `${devId}.deviceState.lightMode`, 'WHITE');
                  break;
                }
                case 'colour': {
                  set(deviceOverrides, `${devId}.deviceState.lightMode`, 'COLOR');
                  break;
                }
                case 'scene': {
                  set(deviceOverrides, `${devId}.deviceState.lightMode`, 'SCENE');
                  break;
                }
                default:
                  break;
              }
              break;
            case 'scene_data':
              set(
                deviceOverrides,
                `${devId}.deviceState.sceneValues`,
                status.value,
              );
              break;
            case 'colour_data': {
              const { h, s, v } = JSON.parse(status.value);
              set(deviceOverrides, `${devId}.deviceState.hsvColor`, {
                hue: h,
                saturation: s / 256 * 100,
                brightness: v / 256 * 100,
              });
              break;
            }
            case 'pir':
              hejEvent.emit(EVENT_MOTION_DETECTED, devId, status.value);
              break;
            case 'bright_value':
              set(deviceOverrides, `${devId}.deviceState.brightness`, status.value / 256 * 100);
              break;
            case 'switch_1':
              set(deviceOverrides, `${devId}.deviceState.power1`, status.value);
              break;
            case 'switch_2':
              set(deviceOverrides, `${devId}.deviceState.power2`, status.value);
              break;
            case 'switch1_value':
            case 'switch2_value':
            case 'switch3_value':
            case 'switch4_value': {
              const idx = Number(status.code.replace('switch', '').replace('_value', '')) - 1;
              hejEvent.emit(EVENT_BUTTON_PRESSED, devId, idx, status.value);
              break;
            }
            default:
              platform.log.info('unknown status code', status);
              break;
          }
        });
      }

      if (devId) {
        const cached = hejDevices[devId];

        if (cached) {
          const updated = deviceOverrides[devId] || {};
          hejDevices[devId] = deepmerge(cached, updated);
        }

        hejEvent.emit('deviceUpdated', hejDevices[devId]);
      }
    } catch (error) {
      platform.log.error('mqtt onMessageArrived processing error', error);
    }
  };

  client.connect({
    timeout: 3,
    keepAliveInterval: 30,
    userName: HEJ_CLIENT_ID,
    password: HEJ_CLIENT_SECRET,
    useSSL: false,
    onSuccess: () => {
      const email = platform.config.credentials?.email.replace(/\./gi, '-').replace(/%40/gi, '@');
      client.subscribe(`custom.${email}.*`, {
        qos: 1,
        timeout: 10,
        onSuccess: () => {
          platform.log.info('mqtt subscribe onSuccess');
        },
        onFailure: () => {
          platform.log.info('mqtt subscribe onFailure');
        },
      });
    },
    onFailure: (e) => {
      platform.log.info('mqtt conn onFailure', e.errorMessage, e.errorCode);
    },
  });

  await loadSnapshot(platform);
};
