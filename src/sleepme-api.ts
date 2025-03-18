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
    "about.firmware_version"?: string;
}

// Static rate limiting variables shared across instances
interface RequestCounts {
    [minute: string]: number;
}
const requestsPerMinute: RequestCounts = {};
let rateLimitResetTime = 0;
let minRequestDelay = 250; // Minimum delay between requests (milliseconds)

export class SleepMeApi {
    public readonly baseUrl = 'https://api.developer.sleep.me/v1';
    private readonly MAX_REQUESTS_PER_MINUTE = 8; // Conservative (actual limit is 10)
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
            this.log.debug('[API] Getting SleepMe devices...');
            
            const devices = await this.queueRequest(async () => {
                this.log.debug('[API] Sending GET request to /devices');
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
                
                this.logApiResponse('GET', '/devices', response);
                
                let devices: Device[] = [];
                
                if (Array.isArray(response.data)) {
                    devices = response.data;
                    this.log.debug(`[API] Found ${devices.length} devices in array response`);
                } else if (response.data && typeof response.data === 'object' && response.data.devices) {
                    devices = response.data.devices;
                    this.log.debug(`[API] Found ${devices.length} devices in object.devices response`);
                } else if (response.data && typeof response.data === 'object') {
                    devices = [response.data];
                    this.log.debug('[API] Found single device in object response');
                }
                
                // Validate devices have required fields
                devices = devices.filter(device => {
                    if (!device.id) {
                        this.log.warn(`[API] Found device without ID: ${JSON.stringify(device)}`);
                        return false;
                    }
                    return true;
                });
                
                this.log.debug(`[API] Found ${devices.length} valid SleepMe devices`);
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
            this.log.error('[API] getDeviceStatus called with undefined deviceId');
            return null;
        }
        
        try {
            this.log.debug(`[API] Getting status for device ${deviceId}...`);
            
            return await this.queueRequest(async () => {
                this.log.debug(`[API] Sending GET request to /devices/${deviceId}`);
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
                
                this.logApiResponse('GET', `/devices/${deviceId}`, response);
                
                if (!response.data) {
                    this.log.error(`[API] Empty response data for device ${deviceId}`);
                    return null;
                }
                
                if (this.verbose) {
                    this.log.debug(`[API] Raw device data: ${JSON.stringify(response.data)}`);
                }
                
                // Extract the relevant fields we need
                const deviceStatus: DeviceStatus = {
                    "control.target_temperature_c": this.ensureValidTemperature(
                        this.extractNestedValue(response.data, 'control.set_temperature_c') || 
                        this.extractNestedValue(response.data, 'set_temperature_c') ||
                        this.convertFtoC(this.extractNestedValue(response.data, 'set_temperature_f')) ||
                        21
                    ),
                    "control.current_temperature_c": this.ensureValidTemperature(
                        this.extractNestedValue(response.data, 'status.water_temperature_c') || 
                        this.extractNestedValue(response.data, 'water_temperature_c') ||
                        this.convertFtoC(this.extractNestedValue(response.data, 'water_temperature_f')) ||
                        21
                    ),
                    "control.thermal_control_status": this.extractNestedValue(response.data, 'thermal_control_status') ||
                                                     this.extractNestedValue(response.data, 'control.thermal_control_status')
                };
                
                // Extract humidity if available
                const humidity = this.extractNestedValue(response.data, 'status.humidity') || 
                                this.extractNestedValue(response.data, 'humidity');
                                
                if (humidity !== undefined && typeof humidity === 'number') {
                    deviceStatus["status.humidity"] = Math.min(100, Math.max(0, Math.round(humidity)));
                }
                
                // Extract firmware version if available
                const firmwareVersion = this.extractNestedValue(response.data, 'about.firmware_version') ||
                                       this.extractNestedValue(response.data, 'firmware_version');
                if (firmwareVersion) {
                    deviceStatus["about.firmware_version"] = firmwareVersion;
                }
                
                this.log.debug(`[API] Parsed device status: ${JSON.stringify(deviceStatus)}`);
                return deviceStatus;
            });
        } catch (error) {
            this.handleApiError(`getDeviceStatus(${deviceId})`, error);
            return null;
        }
    }

    /**
     * Turn device on by setting thermal_control_status to "active"
     * According to observed API behavior
     */
    async turnDeviceOn(deviceId: string, temperature?: number): Promise<boolean> {
        try {
            // First get current temperature if none provided
            if (temperature === undefined) {
                const status = await this.getDeviceStatus(deviceId);
                if (status && status["control.target_temperature_c"]) {
                    temperature = status["control.target_temperature_c"];
                } else {
                    this.log.debug(`[API] No current temperature available, using default of 21°C`);
                    temperature = 21;
                }
            }
            
            // Validate temperature
            const validTemp = this.ensureValidTemperature(temperature);
            
            this.log.info(`[API] Turning device ${deviceId} ON with temperature ${validTemp}°C`);
            
            // Create payload according to observed API behavior
            const payload = {
                "set_temperature_c": validTemp,
                "thermal_control_status": "active"
            };
            
            // Set the device state
            return await this.updateDeviceSettings(deviceId, payload);
        } catch (error) {
            this.handleApiError(`turnDeviceOn(${deviceId})`, error);
            return false;
        }
    }

    /**
     * Turn device off by setting thermal_control_status to "standby"
     * According to observed API behavior
     */
    async turnDeviceOff(deviceId: string): Promise<boolean> {
        try {
            this.log.info(`[API] Turning device ${deviceId} OFF`);
            
            // Create payload according to observed API behavior
            const payload = {
                "thermal_control_status": "standby"
            };
            
            // Set the device state
            return await this.updateDeviceSettings(deviceId, payload);
        } catch (error) {
            this.handleApiError(`turnDeviceOff(${deviceId})`, error);
            return false;
        }
    }

    /**
     * Set temperature only (device must already be on)
     */
    async setTemperature(deviceId: string, temperature: number): Promise<boolean> {
        try {
            // Validate temperature
            const validTemp = this.ensureValidTemperature(temperature);
            
            this.log.info(`[API] Setting device ${deviceId} temperature to ${validTemp}°C`);
            
            // Create payload according to observed API behavior
            const payload = {
                "set_temperature_c": validTemp
            };
            
            // Update device settings
            return await this.updateDeviceSettings(deviceId, payload);
        } catch (error) {
            this.handleApiError(`setTemperature(${deviceId})`, error);
            return false;
        }
    }

    /**
     * Update device settings using a PATCH request
     * This is the core method for controlling a device
     */
    async updateDeviceSettings(deviceId: string, settings: Record<string, any>): Promise<boolean> {
        if (!deviceId) {
            this.log.error('[API] updateDeviceSettings called with undefined deviceId');
            return false;
        }
        
        if (!settings || Object.keys(settings).length === 0) {
            this.log.error('[API] updateDeviceSettings called with empty settings');
            return false;
        }
        
        try {
            this.log.info(`[API] Setting device ${deviceId} settings: ${JSON.stringify(settings)}`);
            
            const success = await this.queueRequest(async () => {
                this.log.debug(`[API] Sending PATCH request to /devices/${deviceId}`);
                const response = await axios({
                    method: 'PATCH',
                    url: `${this.baseUrl}/devices/${deviceId}`,
                    headers: {
                        'Authorization': `Bearer ${this.apiToken}`,
                        'Content-Type': 'application/json',
                    },
                    data: settings,
                    timeout: 10000
                });
                
                this.logApiResponse('PATCH', `/devices/${deviceId}`, response);
                
                if (response.data && this.verbose) {
                    this.log.debug(`[API] Response data: ${JSON.stringify(response.data)}`);
                }
                
                return response.status >= 200 && response.status < 300;
            });
            
            // If successful, log and optionally verify the changes
            if (success) {
                this.log.info(`[API] Successfully updated device ${deviceId} settings`);
                
                // Get updated device status for verification (if verbose logging)
                if (this.verbose) {
                    // Add a small delay to allow the device to update
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    const updatedStatus = await this.getDeviceStatus(deviceId);
                    this.log.debug(`[API] Updated device status: ${JSON.stringify(updatedStatus)}`);
                }
            }
            
            return success;
        } catch (error) {
            this.handleApiError(`updateDeviceSettings(${deviceId})`, error);
            return false;
        }
    }

    /**
     * Convert temperature from Fahrenheit to Celsius
     */
    private convertFtoC(tempF: number | undefined): number | undefined {
        if (tempF === undefined || typeof tempF !== 'number') {
            return undefined;
        }
        
        return (tempF - 32) * 5/9;
    }

    /**
     * Log API response for debugging
     */
    private logApiResponse(method: string, url: string, response: AxiosResponse): void {
        const logPrefix = '[API]';
        if (response.status >= 400) {
            this.log.error(`${logPrefix} ${method} ${url} - Status: ${response.status}`);
            
            // Include response data for error debugging
            if (response.data) {
                try {
                    const dataStr = typeof response.data === 'object' 
                        ? JSON.stringify(response.data)
                        : String(response.data);
                    this.log.error(`${logPrefix} Response data: ${dataStr}`);
                } catch {
                    this.log.error(`${logPrefix} Response data available but could not stringify`);
                }
            }
        } else {
            this.log.debug(`${logPrefix} ${method} ${url} - Status: ${response.status}`);
        }
    }

    /**
     * Queue an API request to ensure proper rate limiting
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
        if (data && data[path] !== undefined) {
            return data[path];
        }
        
        // Then try to traverse the nested path
        const parts = path.split('.');
        let current = data;
        
        for (const part of parts) {
            if (current && typeof current === 'object' && part in current) {
                current = current[part];
            } else {
                // For special cases like status.humidity check specific object structures
                if (parts[0] === 'status' && parts.length === 2 && data && data.status && data.status[parts[1]] !== undefined) {
                    return data.status[parts[1]];
                }
                if (parts[0] === 'control' && parts.length === 2 && data && data.control && data.control[parts[1]] !== undefined) {
                    return data.control[parts[1]];
                }
                if (parts[0] === 'about' && parts.length === 2 && data && data.about && data.about[parts[1]] !== undefined) {
                    return data.about[parts[1]];
                }
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
            this.log.warn(`[API] Invalid temperature value: ${temp}, using default of 21°C`);
            return 21;
        }
        
        if (temp < MIN_TEMP) {
            this.log.warn(`[API] Temperature value ${temp}°C below minimum, using ${MIN_TEMP}°C`);
            return MIN_TEMP;
        }
        
        if (temp > MAX_TEMP) {
            this.log.warn(`[API] Temperature value ${temp}°C above maximum, using ${MAX_TEMP}°C`);
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
            `[API] Rate limit hit! Increasing delay to ${minRequestDelay}ms ` +
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
            this.log.debug(`[API] In rate limit cooldown period, waiting ${delay}ms before next request`);
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
                `[API] Rate limit approaching (${currentMinuteRequests}/${this.MAX_REQUESTS_PER_MINUTE} ` +
                `requests in current minute). Waiting ${delay}ms for next minute.`
            );
            
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        // Always add a small delay between requests
        this.log.debug(`[API] Adding standard delay of ${minRequestDelay}ms between requests`);
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
                    `[API] Error in ${method}: Status ${axiosError.response.status} - ` +
                    `${JSON.stringify(axiosError.response.data)}`
                );
                
                // Handle specific error codes
                if (axiosError.response.status === 401) {
                    this.log.error('[API] Authentication failed. Please check your API token.');
                } else if (axiosError.response.status === 404) {
                    this.log.error('[API] Resource not found. Please check if the device ID is correct.');
                } else if (axiosError.response.status === 429) {
                    this.handleRateLimitExceeded();
                }
                
            } else if (axiosError.request) {
                // Request was made but no response received
                this.log.error(
                    `[API] Error in ${method}: No response received - ` +
                    `${axiosError.message}`
                );
                this.log.error('[API] Please check your network connection and API endpoint.');
                
            } else {
                // Error setting up the request
                this.log.error(`[API] Error in ${method}: ${axiosError.message}`);
            }
            
        } else if (error instanceof Error) {
            this.log.error(`[API] Error in ${method}: ${error.message}`);
            
        } else {
            this.log.error(`[API] Unknown error in ${method}: ${error}`);
        }
    }
}