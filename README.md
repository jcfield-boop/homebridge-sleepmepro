# Homebridge SleepMePro Plugin

A Homebridge plugin for controlling your SleepMe device through Apple HomeKit. This integration allows you to control the temperature of your SleepMe device and take advantage of HomeKit automation capabilities.

<p align="center">
<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-color-round-stylized.png" width="150">
</p>

## Features

- Control your SleepMe device temperature from HomeKit
- View current and target temperature in your Home app
- Monitor heating state
- Set scheduled temperature changes
- "Warm Awake" feature for gradual temperature increase before wake times

## Installation

You can install this plugin through the Homebridge UI or manually using npm:

```bash
npm install -g homebridge-sleepmepro
```

## Configuration

Add the following to the "accessories" section of your Homebridge config.json:

```json
{
  "accessory": "SleepMeAccessory",
  "name": "SleepMe Bed",
  "apiToken": "YOUR_SLEEPME_API_TOKEN",
  "unit": "C",
  "temperatureSchedule": [
    {
      "day": "everyday",
      "time": "22:00",
      "temperature": 28
    },
    {
      "day": "monday",
      "time": "06:30",
      "temperature": 20,
      "isWakeTime": true,
      "warmAwakeSettings": {
        "warmUpEnabled": true,
        "warmUpDuration": 30,
        "warmUpTemperature": 32
      }
    }
  ]
}
```

### Configuration Options

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `accessory` | String | Required | Must be "SleepMeAccessory" |
| `name` | String | Required | Name of your accessory that will appear in HomeKit |
| `apiToken` | String | Required | Your SleepMe API token |
| `unit` | String | "C" | Temperature unit: "C" for Celsius, "F" for Fahrenheit |
| `temperatureSchedule` | Array | [] | Schedule for automatic temperature changes |

### Temperature Schedule

Each schedule entry supports the following properties:

| Property | Type | Description |
|----------|------|-------------|
| `day` | String | Day of the week (lowercase) or "everyday" |
| `time` | String | Time in 24-hour format (HH:MM) |
| `temperature` | Number | Target temperature |
| `isWakeTime` | Boolean | Whether this is a wake-up time (for warm awake feature) |
| `warmAwakeSettings` | Object | Settings for the warm awake feature |

#### Warm Awake Settings

| Property | Type | Description |
|----------|------|-------------|
| `warmUpEnabled` | Boolean | Enable/disable warm-up before wake time |
| `warmUpDuration` | Number | Minutes before wake time to start warming |
| `warmUpTemperature` | Number | Peak temperature for warm-up period |

## API Rate Limiting

The plugin implements rate limiting to prevent excessive API calls to the SleepMe servers. It limits calls to 9 requests per minute.

## Troubleshooting

### Authentication Issues

If you see "Authentication failed" errors in your Homebridge logs, verify that your API token is correct and not expired.

### Device Status Errors

If the plugin fails to retrieve device status, check your network connection and ensure your SleepMe device is online and properly set up in the SleepMe app.

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

## Obtaining an API Token

To obtain your SleepMe API token:
1. Contact SleepMe customer support
2. Use the SleepMe developer portal (if available)
3. Use network inspection tools while logged into the SleepMe app

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Disclaimer

This plugin is not officially associated with SleepMe. Use at your own risk.
 
