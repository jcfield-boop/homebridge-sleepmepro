import { API } from 'homebridge';
import { SleepMePlatform } from './platform';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export default (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SleepMePlatform);
};