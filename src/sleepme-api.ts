import axios, { AxiosResponse, AxiosError } from 'axios';
import { Logger } from 'homebridge';

export interface Device {
    id: string;
    name: string;
    attachments: string;
    // Add any other properties returned by the API
}

export interface DeviceStatus {
    "control.target_temperature_c": number;
    "control.current_temperature_c": number;
    "control.thermal_control_status"?: string;
    // Add other properties based on the API documentation
}

export interface DeviceSettings {
    "control.set_temperature_c"?: number;
    "control.thermal_control_status"?: string;
    // Add other settings properties as needed
}

export class SleepMeApi {
    public readonly baseUrl = 'https://api.developer.sleep.me/v1';

    constructor(
        private readonly apiToken: string, 
        private readonly log: Logger
    ) {
        // Validate API token
        if (!apiToken || apiToken.trim() === '') {
            this.log.error('Invalid API token provided');
        }
    }

    /**
     * Get all devices from the SleepMe API
     */
    async getDevices(): Promise<Device[]> {
        try {
            this.log.debug('Getting SleepMe devices...');
            
            const response: AxiosResponse = await axios({
                method: 'GET',
                url: `${this.baseUrl}/devices`,
                headers: {
                    'Authorization': `Bearer ${this.apiToken}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 10000 // 10 second timeout
            });

            this.log.debug(`API Response Status: ${response.status}`);
            
            // Handle possible response formats
            let devices: Device[] = [];
            
            if (Array.isArray(response.data)) {
                devices = response.data;
            } else if (response.data && typeof response.data === 'object' && response.data.devices) {
                // Some APIs wrap the results in a data property
                devices = response.data.devices;
            } else if (response.data && typeof response.data === 'object') {
                // If it's an object but not an array, might be a single device
                devices = [response.data];
            }
            
            // Validate devices have required fields
            devices = devices.filter(device => {
                if (!device.id) {
                    this.log.warn(`Found device without ID: ${JSON.stringify(device)}`);
                    return false;
                }
                return true;
            });

            this.log.debug(`Found ${devices.length} valid SleepMe devices`);
            return devices;
            
        } catch (error) {
            this.handleApiError('getDevices', error);
            return [];
        }
    }

    /**
     * Get status for a specific device
     */
    async getDeviceStatus(deviceId: string): Promise<DeviceStatus | null> {
        if (!deviceId) {
            this.log.error('getDeviceStatus called with undefined deviceId');
            return null;
        }
        
        try {
            this.log.debug(`Getting status for device ${deviceId}...`);
            
            const response: AxiosResponse = await axios({
                method: 'GET',
                url: `${this.baseUrl}/devices/${deviceId}`,
                headers: {
                    'Authorization': `Bearer ${this.apiToken}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 10000 // 10 second timeout
            });
            
            this.log.debug(`API Response Status: ${response.status} for device ${deviceId}`);
            
            if (!response.data) {
                this.log.error(`Empty response data for device ${deviceId}`);
                return null;
            }
            
            // Extract the relevant fields we need
            const deviceStatus: DeviceStatus = {
                "control.target_temperature_c": this.extractNestedValue(response.data, 'control.set_temperature_c') || 
                                              this.extractNestedValue(response.data, 'control.target_temperature_c') || 21,
                "control.current_temperature_c": this.extractNestedValue(response.data, 'status.water_temperature_c') || 
                                               this.extractNestedValue(response.data, 'control.current_temperature_c') || 21,
                "control.thermal_control_status": this.extractNestedValue(response.data, 'control.thermal_control_status')
            };
            
            this.log.debug(`Parsed device status: ${JSON.stringify(deviceStatus)}`);
            return deviceStatus;
            
        } catch (error) {
            this.handleApiError(`getDeviceStatus(${deviceId})`, error);
            return null;
        }
    }

    /**
     * Update settings for a specific device
     */
    async setDeviceSettings(deviceId: string, settings: DeviceSettings): Promise<boolean> {
        if (!deviceId) {
            this.log.error('setDeviceSettings called with undefined deviceId');
            return false;
        }

        try {
            this.log.debug(`Setting settings for device ${deviceId}: ${JSON.stringify(settings)}`);
            
            const response = await axios({
                method: 'PATCH',
                url: `${this.baseUrl}/devices/${deviceId}`,
                headers: {
                    'Authorization': `Bearer ${this.apiToken}`,
                    'Content-Type': 'application/json',
                },
                data: settings,
                timeout: 10000 // 10 second timeout
            });
            
            this.log.debug(`API Response Status: ${response.status} for updating device ${deviceId}`);
            this.log.info(`Successfully updated settings for device ${deviceId}`);
            return true;
            
        } catch (error) {
            this.handleApiError(`setDeviceSettings(${deviceId})`, error);
            return false;
        }
    }

    /**
     * Helper method to extract values from nested objects or flattened objects with dot notation
     */
    private extractNestedValue(data: any, path: string): any {
        // First check if the property exists directly (flattened format)
        if (data[path] !== undefined) {
            return data[path];
        }
        
        // Then try to traverse the nested path
        const parts = path.split('.');
        let current = data;
        
        for (const part of parts) {
            if (current && typeof current === 'object' && part in current) {
                current = current[part];
            } else {
                return undefined;
            }
        }
        
        return current;
    }

    /**
     * Standardized error handling for API calls
     */
    private handleApiError(method: string, error: unknown): void {
        if (axios.isAxiosError(error)) {
            const axiosError = error as AxiosError;
            
            if (axiosError.response) {
                // Server responded with error status
                this.log.error(
                    `API Error in ${method}: Status ${axiosError.response.status} - ` +
                    `${JSON.stringify(axiosError.response.data)}`
                );
                
                if (axiosError.response.status === 401) {
                    this.log.error('Authentication failed. Please check your API token.');
                } else if (axiosError.response.status === 404) {
                    this.log.error('Resource not found. Please check if the device ID is correct.');
                }
                
            } else if (axiosError.request) {
                // Request was made but no response received
                this.log.error(
                    `API Error in ${method}: No response received - ` +
                    `${axiosError.message}`
                );
                this.log.error('Please check your network connection and API endpoint.');
                
            } else {
                // Error setting up the request
                this.log.error(`API Error in ${method}: ${axiosError.message}`);
            }
            
        } else if (error instanceof Error) {
            this.log.error(`Error in ${method}: ${error.message}`);
            
        } else {
            this.log.error(`Unknown error in ${method}: ${error}`);
        }
    }
}