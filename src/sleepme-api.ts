import axios, { AxiosResponse } from 'axios';
import { Logger } from 'homebridge';

interface Device {
    id: string;
    name: string;
    attachments: string;
}

interface DeviceStatus {
    "control.target_temperature_c": number;
    "control.current_temperature_c": number;
    // Add other properties based on the API documentation
}

interface DeviceSettings {
    "control.set_temperature_c"?: number;
    // Add other settings properties as needed
}

export class SleepMeApi {
    public readonly baseUrl = 'https://api.developer.sleep.me/v1';

    constructor(
        private readonly apiToken: string, 
        private readonly log: Logger
    ) {}

    async getDevices(): Promise<Device[]> {
        try {
            this.log.debug('Getting SleepMe devices...');
            const response: AxiosResponse<Device[]> = await axios.get(`${this.baseUrl}/devices`, {
                headers: {
                    Authorization: `Bearer ${this.apiToken}`,
                },
            });

            this.log.debug('SleepMe API device response:', response.data);

            if (!response.data || !Array.isArray(response.data)) {
                this.log.error('Invalid or empty response from SleepMe API.');
                return [];
            }

            return response.data;
        } catch (error: any) {
            this.log.error('Error getting SleepMe devices:', error.message);
            return [];
        }
    }

    async getDeviceStatus(deviceId: string): Promise<DeviceStatus | null> {
        try {
            this.log.debug(`Getting status for device ${deviceId}...`);
            const response: AxiosResponse<any> = await axios.get(`${this.baseUrl}/devices/${deviceId}`, {
                headers: {
                    Authorization: `Bearer ${this.apiToken}`,
                },
            });

            this.log.debug('Raw SleepMe API status response:', response.data);

            if (!response.data) {
                this.log.error(`Invalid response data for device ${deviceId}`);
                return null;
            }

            const deviceStatus: DeviceStatus = {
                "control.target_temperature_c": response.data["control.target_temperature_c"],
                "control.current_temperature_c": response.data["control.current_temperature_c"],
                // Extract other status properties as needed
            };

            this.log.debug(`Parsed SleepMe API status response for ${deviceId}:`, deviceStatus);

            return deviceStatus;
        } catch (error: any) {
            this.log.error(`Error getting status for device ${deviceId}:`, error.message);
            return null;
        }
    }

    async setDeviceSettings(deviceId: string, settings: DeviceSettings): Promise<void> {
        try {
            this.log.debug(`Setting settings for device ${deviceId}:`, settings);
            await axios.patch(`${this.baseUrl}/devices/${deviceId}`, settings, {
                headers: {
                    Authorization: `Bearer ${this.apiToken}`,
                },
            });

            this.log.debug(`Successfully set settings for device ${deviceId}.`);
        } catch (error: any) {
            this.log.error(`Error setting settings for device ${deviceId}:`, error.message);
            throw error;
        }
    }
}