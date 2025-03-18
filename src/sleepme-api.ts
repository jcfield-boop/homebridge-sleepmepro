import axios, { AxiosResponse, AxiosError } from 'axios';
import { Logger } from 'homebridge';

export interface Device {
    id: string;
    name: string;
    attachments: string;
}

export interface DeviceStatus {
    "control.target_temperature_c": number;
    "control.current_temperature_c": number;
    "control.thermal_control_status"?: string;
}

export interface DeviceSettings {
    "control.set_temperature_c"?: number;
    "control.thermal_control_status"?: string;
    "control.power"?: string;
}

// Static rate limiting variables shared across instances
// Track requests per discrete minute
interface RequestCounts {
    [minute: string]: number;
}
const requestsPerMinute: RequestCounts = {};
let rateLimitResetTime = 0;
let minRequestDelay = 250; // Minimum delay between requests (milliseconds)

export class SleepMeApi {
    public readonly baseUrl = 'https://api.developer.sleep.me/v1';
    private readonly MAX_REQUESTS_PER_MINUTE = 8; // Slightly conservative (actual limit is 10)
    private static requestPromise = Promise.resolve<unknown>(null); // For sequential requests

    constructor(
        private readonly apiToken: string, 
        private readonly log: Logger
    ) {
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
            
            const devices = await this.queueRequest(async () => {
                const response: AxiosResponse = await axios({
                    method: 'GET',
                    url: `${this.baseUrl}/devices`,
                    headers: {
                        'Authorization': `Bearer ${this.apiToken}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    timeout: 10000
                });
                this.log.debug(`API Response Status: ${response.status}`);
                
                let devices: Device[] = [];
                
                if (Array.isArray(response.data)) {
                    devices = response.data;
                } else if (response.data && typeof response.data === 'object' && response.data.devices) {
                    devices = response.data.devices;
                } else if (response.data && typeof response.data === 'object') {
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
            });
            
            return devices || [];
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
            
            return await this.queueRequest(async () => {
                const response: AxiosResponse = await axios({
                    method: 'GET',
                    url: `${this.baseUrl}/devices/${deviceId}`,
                    headers: {
                        'Authorization': `Bearer ${this.apiToken}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    timeout: 10000
                });
                
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
            });
        } catch (error) {
            this.handleApiError(`getDeviceStatus(${deviceId})`, error);
            return null;
        }
    }

    /**
     * Turn the device on with the specified temperature
     */
    async turnDeviceOn(deviceId: string, targetTemperature: number): Promise<boolean> {
        if (!deviceId) {
            this.log.error('turnDeviceOn called with undefined deviceId');
            return false;
        }

        try {
            const validTemp = this.ensureValidTemperature(targetTemperature);
            this.log.info(`Turning on device ${deviceId} with temperature ${validTemp}°C`);

            // First set the target temperature
            await this.queueRequest(async () => {
                await axios({
                    method: 'PATCH',
                    url: `${this.baseUrl}/devices/${deviceId}`,
                    headers: {
                        'Authorization': `Bearer ${this.apiToken}`,
                        'Content-Type': 'application/json',
                    },
                    data: {
                        "control.set_temperature_c": validTemp
                    },
                    timeout: 10000
                });
                this.log.debug('Temperature set successfully');
                return true;
            });

            // Wait a bit before sending the next command (but don't count this against rate limit)
            await new Promise(resolve => setTimeout(resolve, 500));

            // Then turn on the device
            await this.queueRequest(async () => {
                await axios({
                    method: 'PATCH',
                    url: `${this.baseUrl}/devices/${deviceId}`,
                    headers: {
                        'Authorization': `Bearer ${this.apiToken}`,
                        'Content-Type': 'application/json',
                    },
                    data: {
                        "control.power": "on"
                    },
                    timeout: 10000
                });
                this.log.debug('Power turned on successfully');
                return true;
            });

            this.log.info(`Successfully turned on device ${deviceId} at ${validTemp}°C`);
            return true;
        } catch (error) {
            this.handleApiError(`turnDeviceOn(${deviceId})`, error);
            return false;
        }
    }

    /**
     * Turn the device off
     */
    async turnDeviceOff(deviceId: string): Promise<boolean> {
        if (!deviceId) {
            this.log.error('turnDeviceOff called with undefined deviceId');
            return false;
        }

        try {
            this.log.info(`Turning off device ${deviceId}`);
            
            return await this.queueRequest(async () => {
                await axios({
                    method: 'PATCH',
                    url: `${this.baseUrl}/devices/${deviceId}`,
                    headers: {
                        'Authorization': `Bearer ${this.apiToken}`,
                        'Content-Type': 'application/json',
                    },
                    data: {
                        "control.power": "off"
                    },
                    timeout: 10000
                });
                
                this.log.info(`Successfully turned off device ${deviceId}`);
                return true;
            });
        } catch (error) {
            this.handleApiError(`turnDeviceOff(${deviceId})`, error);
            return false;
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
            
            return await this.queueRequest(async () => {
                await axios({
                    method: 'PATCH',
                    url: `${this.baseUrl}/devices/${deviceId}`,
                    headers: {
                        'Authorization': `Bearer ${this.apiToken}`,
                        'Content-Type': 'application/json',
                    },
                    data: settings,
                    timeout: 10000
                });
                
                this.log.debug(`Successfully updated settings for device ${deviceId}`);
                this.log.info(`Successfully updated settings for device ${deviceId}`);
                return true;
            });
        } catch (error) {
            this.handleApiError(`setDeviceSettings(${deviceId})`, error);
            return false;
        }
    }

    /**
     * Queue an API request to ensure proper rate limiting
     * This creates a chain of promises to ensure sequential execution
     */
    private async queueRequest<T>(requestFn: () => Promise<T>): Promise<T> {
        // Create a properly typed Promise that will contain our result
        let resolvePromise: (value: T) => void;
        let rejectPromise: (reason: any) => void;
        
        const resultPromise = new Promise<T>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        
        // Chain this request to the end of our request queue
        SleepMeApi.requestPromise = SleepMeApi.requestPromise.then(async () => {
            try {
                const result = await this.executeWithRateLimit(requestFn);
                resolvePromise(result);
            } catch (error) {
                rejectPromise(error);
            }
        }).catch(async () => {
            // If previous request failed, still try this one
            try {
                const result = await this.executeWithRateLimit(requestFn);
                resolvePromise(result);
            } catch (error) {
                rejectPromise(error);
            }
        });
        
        return resultPromise;
    }

    /**
     * Execute a request function with rate limiting
     */
    private async executeWithRateLimit<T>(requestFn: () => Promise<T>): Promise<T> {
        await this.respectRateLimit();
        
        try {
            const result = await requestFn();
            this.trackRequest();
            return result;
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 429) {
                this.handleRateLimitExceeded();
            }
            throw error;
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
        
        return Math.round(temp * 2) / 2; // Round to nearest 0.5 degree
    }

    /**
     * Track API request for rate limiting
     */
    private trackRequest(): void {
        const currentMinuteKey = this.getCurrentMinuteKey();
        
        // Initialize or increment the request count for this minute
        requestsPerMinute[currentMinuteKey] = (requestsPerMinute[currentMinuteKey] || 0) + 1;
        
        // Clean up old minute entries (older than 5 minutes)
        this.cleanupOldMinuteEntries();
    }

    /**
     * Get the current minute key in format YYYY-MM-DD-HH-MM
     */
    private getCurrentMinuteKey(): string {
        const date = new Date();
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCHours()).padStart(2, '0')}-${String(date.getUTCMinutes()).padStart(2, '0')}`;
    }

    /**
     * Clean up old minute entries to prevent memory leaks
     */
    private cleanupOldMinuteEntries(): void {
        const currentDate = new Date();
        
        // Remove entries older than 5 minutes
        Object.keys(requestsPerMinute).forEach(minuteKey => {
            const [year, month, day, hour, minute] = minuteKey.split('-').map(Number);
            const entryDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
            
            if (currentDate.getTime() - entryDate.getTime() > 5 * 60 * 1000) {
                delete requestsPerMinute[minuteKey];
            }
        });
    }

    /**
     * Handle rate limit exceeded error
     */
    private handleRateLimitExceeded(): void {
        // Increase the minimum delay between requests
        minRequestDelay = Math.min(5000, minRequestDelay * 2);
        
        // Set rate limit cooldown for 60 seconds
        rateLimitResetTime = Date.now() + 60000;
        
        this.log.warn(
            `Rate limit hit! Increasing delay to ${minRequestDelay}ms ` +
            `and pausing requests for 60 seconds.`
        );
    }

    /**
     * Respect rate limits by delaying requests when needed
     */
    private async respectRateLimit(): Promise<void> {
        const currentTime = Date.now();
        
        // If we hit a rate limit recently, wait until reset time
        if (rateLimitResetTime > currentTime) {
            const delay = rateLimitResetTime - currentTime;
            this.log.debug(`In rate limit cooldown period, waiting ${delay}ms before next request`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return;
        }
        
        // Check if we're approaching the rate limit for the current minute
        const currentMinuteKey = this.getCurrentMinuteKey();
        const currentMinuteRequests = requestsPerMinute[currentMinuteKey] || 0;
        
        if (currentMinuteRequests >= this.MAX_REQUESTS_PER_MINUTE) {
            // Calculate time until the next minute starts
            const currentDate = new Date();
            const nextMinute = new Date(currentDate);
            nextMinute.setUTCMinutes(currentDate.getUTCMinutes() + 1, 0, 0); // First second of next minute
            const delay = nextMinute.getTime() - currentDate.getTime() + 100; // Add 100ms buffer
            
            this.log.debug(
                `Rate limit approaching (${currentMinuteRequests}/${this.MAX_REQUESTS_PER_MINUTE} ` +
                `requests in current minute). Waiting ${delay}ms for next minute.`
            );
            
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        // Always add a small delay between requests
        this.log.debug(`Adding standard delay of ${minRequestDelay}ms between requests`);
        await new Promise(resolve => setTimeout(resolve, minRequestDelay));
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
                    this.handleRateLimitExceeded();
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