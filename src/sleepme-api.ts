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
    private lastRequestTime = 0;
    private rateLimitResetTime = 0;
    private requestCount = 0;
    private readonly MAX_REQUESTS_PER_MINUTE = 8; // Conservative limit to avoid rate limiting

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
            
            await this.respectRateLimit();
            
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

            this.trackRequest();
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
            
            await this.respectRateLimit();
            
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
            
            this.trackRequest();
            this.log.debug(`API Response Status: ${response.status} for device ${deviceId}`);
            
            if (!response.data) {
                this.log.error(`Empty response data for device ${deviceId}`);
                return null;
            }
            
            // Extract the relevant fields we need
            const deviceStatus: DeviceStatus = {
                "control.target_temperature_c": this.ensureValidTemperature(
                    this.extractNestedValue(response.data, 'control.set_temperature_c') || 
                    this.extractNestedValue(response.data, 'control.target_temperature_c') || 
                    21
                ),
                "control.current_temperature_c": this.ensureValidTemperature(
                    this.extractNestedValue(response.data, 'status.water_temperature_c') || 
                    this.extractNestedValue(response.data, 'control.current_temperature_c') || 
                    21
                ),
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

        // Validate temperature settings
        if (settings["control.set_temperature_c"] !== undefined) {
            settings["control.set_temperature_c"] = this.ensureValidTemperature(settings["control.set_temperature_c"]);
        }

        try {
            this.log.debug(`Setting settings for device ${deviceId}: ${JSON.stringify(settings)}`);
            
            await this.respectRateLimit();
            
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
            
            this.trackRequest();
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
     * Ensure temperature values are within valid ranges
     * SleepMe devices typically operate between 13°C-46°C
     */
    private ensureValidTemperature(temp: number): number {
        const MIN_TEMP = 13; // 55°F in Celsius
        const MAX_TEMP = 46; // 115°F in Celsius
        
        if (typeof temp !== 'number' || isNaN(temp)) {
            this.log.warn(`Invalid temperature value: ${temp}, using default of 21°C`);
            return 21;
        }
        
        if (temp < MIN_TEMP) {
            this.log.warn(`Temperature value ${temp}°C below minimum, using ${MIN_TEMP}°C`);
            return MIN_TEMP;
        }
        
        if (temp > MAX_TEMP) {
            this.log.warn(`Temperature value ${temp}°C above maximum, using ${MAX_TEMP}°C`);
            return MAX_TEMP;
        }
        
        return Math.round(temp * 10) / 10; // Round to 1 decimal place
    }

    /**
     * Track API request for rate limiting
     */
    private trackRequest(): void {
        const now = Date.now();
        const currentMinute = Math.floor(now / 60000);
        
        // Reset counter if we're in a new minute
        if (this.lastRequestTime === 0 || Math.floor(this.lastRequestTime / 60000) < currentMinute) {
            this.requestCount = 1;
        } else {
            this.requestCount++;
        }
        
        this.lastRequestTime = now;
    }

    /**
     * Respect rate limits by delaying requests when needed
     */
    private async respectRateLimit(): Promise<void> {
        const now = Date.now();
        
        // If we've hit a rate limit, wait until the reset time
        if (this.rateLimitResetTime > now) {
            const delay = this.rateLimitResetTime - now;
            this.log.debug(`Rate limit hit, waiting ${delay}ms before next request`);
            await new Promise(resolve => setTimeout(resolve, delay));
            this.rateLimitResetTime = 0;
            this.requestCount = 0;
            return;
        }
        
        // If we've made too many requests in the current minute, wait until next minute
        const currentMinute = Math.floor(now / 60000);
        if (this.lastRequestTime > 0 && 
            Math.floor(this.lastRequestTime / 60000) === currentMinute &&
            this.requestCount >= this.MAX_REQUESTS_PER_MINUTE) {
            
            const nextMinute = (currentMinute + 1) * 60000;
            const delay = nextMinute - now + 100; // Add 100ms buffer
            
            this.log.debug(`Approaching rate limit, waiting ${delay}ms before next request`);
            await new Promise(resolve => setTimeout(resolve, delay));
            this.requestCount = 0;
        }
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
                
                // Handle specific error codes
                if (axiosError.response.status === 401) {
                    this.log.error('Authentication failed. Please check your API token.');
                } else if (axiosError.response.status === 404) {
                    this.log.error('Resource not found. Please check if the device ID is correct.');
                } else if (axiosError.response.status === 429) {
                    // Rate limit hit, set a reset time 60 seconds in the future
                    this.rateLimitResetTime = Date.now() + 60000;
                    this.log.warn(`Rate limit exceeded. Pausing requests for 60 seconds.`);
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