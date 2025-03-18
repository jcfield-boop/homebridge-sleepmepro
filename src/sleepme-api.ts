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
    "status.humidity"?: number;
}

export interface DeviceSettings {
    "control.set_temperature_c"?: number;
    "control.thermal_control_status"?: string;
    "control.power"?: string;
}

interface DeviceControlOptions {
    power?: 'on' | 'off';
    temperature?: number;
    debugMode?: boolean;
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
    private readonly verbose: boolean;

    constructor(
        private readonly apiToken: string, 
        private readonly log: Logger,
        verbose = false
    ) {
        if (!apiToken || apiToken.trim() === '') {
            this.log.error('Invalid API token provided');
        }
        this.verbose = verbose;
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
                
                // Extract humidity if available
                const humidity = this.extractNestedValue(response.data, 'status.humidity') || 
                                this.extractNestedValue(response.data, 'humidity');
                                
                if (humidity !== undefined && typeof humidity === 'number') {
                    deviceStatus["status.humidity"] = Math.min(100, Math.max(0, Math.round(humidity)));
                }
                
                this.log.debug(`Parsed device status: ${JSON.stringify(deviceStatus)}`);
                return deviceStatus;
            });
        } catch (error) {
            this.handleApiError(`getDeviceStatus(${deviceId})`, error);
            return null;
        }
    }

    /**
     * Set device control state based on SleepMe API documentation
     * According to https://docs.developer.sleep.me/api/
     */
    async controlDevice(deviceId: string, controlOptions: DeviceControlOptions): Promise<boolean> {
        if (!deviceId) {
            this.log.error('controlDevice called with undefined deviceId');
            return false;
        }

        const { power, temperature, debugMode = false } = controlOptions;
        const isDebug = debugMode || this.verbose;

        try {
            // First get current device state for logging
            if (isDebug) {
                const initialStatus = await this.getDeviceStatus(deviceId);
                this.log.debug(`[DEVICE CONTROL] Initial device state: ${JSON.stringify(initialStatus)}`);
            }

            // Prepare the payload according to the docs
            const payload: Record<string, any> = {};
            
            // Add temperature if specified
            if (temperature !== undefined) {
                const validTemp = this.ensureValidTemperature(temperature);
                payload["control.set_temperature_c"] = validTemp;
                this.log.info(`[DEVICE CONTROL] Setting temperature to ${validTemp}°C`);
            }
            
            // Add power if specified
            if (power !== undefined) {
                payload["control.power"] = power;
                this.log.info(`[DEVICE CONTROL] Setting power to ${power.toUpperCase()}`);
            }
            
            this.log.debug(`[DEVICE CONTROL] Sending payload: ${JSON.stringify(payload)}`);
            
            // Send the control command
            let responseData: any = null;
            const response = await this.queueRequest(async () => {
                const response = await axios({
                    method: 'PATCH',
                    url: `${this.baseUrl}/devices/${deviceId}`,
                    headers: {
                        'Authorization': `Bearer ${this.apiToken}`,
                        'Content-Type': 'application/json',
                    },
                    data: payload,
                    timeout: 10000
                });
                
                responseData = response.data;
                return response;
            });
            
            this.log.debug(`[DEVICE CONTROL] API response: ${response.status}`);
            
            if (responseData) {
                this.log.debug(`[DEVICE CONTROL] Response data: ${JSON.stringify(responseData)}`);
            }
            
            // Get updated device status
            if (isDebug) {
                // Add a small delay to allow the device to update
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const newStatus = await this.getDeviceStatus(deviceId);
                this.log.debug(`[DEVICE CONTROL] Updated device state: ${JSON.stringify(newStatus)}`);
                
                // Check if the request had the desired effect
                let powerChanged = true;
                if (power !== undefined && newStatus) {
                    const expectedStatus = power === 'on' ? 'active' : 'standby';
                    const actualStatus = newStatus["control.thermal_control_status"] || 'unknown';
                    
                    if (actualStatus !== expectedStatus) {
                        powerChanged = false;
                        this.log.warn(`[DEVICE CONTROL] Power state mismatch! Expected: ${expectedStatus}, Actual: ${actualStatus}`);
                    }
                }
                
                let tempChanged = true;
                if (temperature !== undefined && newStatus) {
                    const expectedTemp = this.ensureValidTemperature(temperature);
                    const actualTemp = newStatus["control.target_temperature_c"];
                    
                    if (Math.abs(actualTemp - expectedTemp) > 0.1) { // Allow small rounding differences
                        tempChanged = false;
                        this.log.warn(`[DEVICE CONTROL] Temperature mismatch! Expected: ${expectedTemp}°C, Actual: ${actualTemp}°C`);
                    }
                }
                
                if (!powerChanged || !tempChanged) {
                    this.log.warn(`[DEVICE CONTROL] Device state did not change as expected. This could indicate an API issue or device connectivity problem.`);
                } else {
                    this.log.info(`[DEVICE CONTROL] Successfully updated device state`);
                }
            }
            
            return true;
        } catch (error) {
            this.handleApiError(`controlDevice(${deviceId})`, error);
            return false;
        }
    }

    /**
     * Turn device on - simplified implementation based on API docs
     */
    async turnDeviceOn(deviceId: string, temperature?: number): Promise<boolean> {
        this.log.info(`[DEVICE CONTROL] Turning device ${deviceId} ON${temperature ? ` at ${temperature}°C` : ''}`);
        
        // Get current temperature if none provided
        if (temperature === undefined) {
            const status = await this.getDeviceStatus(deviceId);
            if (status && status["control.target_temperature_c"]) {
                temperature = status["control.target_temperature_c"];
            } else {
                temperature = 21; // Default temp if we can't get current
            }
        }
        
        return this.controlDevice(deviceId, {
            power: 'on',
            temperature,
            debugMode: true
        });
    }

    /**
     * Turn device off - simplified implementation based on API docs
     */
    async turnDeviceOff(deviceId: string): Promise<boolean> {
        this.log.info(`[DEVICE CONTROL] Turning device ${deviceId} OFF`);
        
        return this.controlDevice(deviceId, {
            power: 'off',
            debugMode: true
        });
    }

    /**
     * Set device temperature - simplified implementation based on API docs
     */
    async setTemperature(deviceId: string, temperature: number): Promise<boolean> {
        this.log.info(`[DEVICE CONTROL] Setting device ${deviceId} temperature to ${temperature}°C`);
        
        return this.controlDevice(deviceId, {
            temperature,
            debugMode: true
        });
    }

    /**
     * Queue an API request to ensure proper rate limiting
     * This creates a chain of promises to ensure sequential execution
     */
    private async queueRequest<T>(requestFn: () => Promise<T>): Promise<T> {
        // Create a properly typed Promise that will contain our result
        let resolvePromise!: (value: T) => void;
        let rejectPromise!: (reason: any) => void;
        
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
        
        // Special case for status.humidity
        if (path === "status.humidity" && data.status && data.status.humidity !== undefined) {
            return data.status.humidity;
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