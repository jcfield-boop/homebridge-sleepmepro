import { API } from 'homebridge';
import { SleepMePlatform } from './platform';
import { PLATFORM_NAME } from './settings';

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, SleepMePlatform);
};