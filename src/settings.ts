import { PlatformConfig } from 'homebridge';

/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'Hejhome';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = '@chazepps/homebridge-hejhome';

// Config
export interface HejhomePlatformConfig extends PlatformConfig {
  credentials?: Credentials;
}

interface Credentials {
  email: string;
  password: string;
  // TODO: Will be required in the future
  // familyId?: string;
  // roomId?: string;
}
