<p align="center">

<img src="https://raw.githubusercontent.com/chazepps/homebridge-hejhome/latest/branding/logo.png" height="150">

</p>

<h1 align="center">Homebridge Hejhome Plugin</h1>

The Hejhome plugin facilitates seamless integration of Hejhome devices with HomeKit.

### Supported Devices List

Currently supported devices are listed below. I am working based on the products I own, so if you want to add a device, feel free to send a PR or request it in an issue, and I will try to purchase and work on it.

| Status    | Name                           | Product Link                                                | Notes                                                                  |
| --------- | ------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| ✅ Stable | Zigbee Switch (1-gang, 2-gang) | [Link](https://hej.life/product/detail.html?product_no=95)  | 3-gang not supported yet                                               |
| ✅ Stable | Smart Bulb (Color)             | [Link](https://hej.life/product/detail.html?product_no=100) |                                                                        |
| 🟡 WIP    | Smart Button                   | [Link](https://hej.life/product/detail.html?product_no=105) | Bug: Settings sometimes disappear in Home app when updating the plugin |
| 🟡 WIP    | Smart Motion Sensor            | [Link](https://hej.life/product/detail.html?product_no=107) | Not fully tested yet                                                   |
| 🟡 WIP    | Smart Line LED                 | [Link](https://hej.life/product/detail.html?product_no=116) | Not fully tested yet                                                   |

### Development Environment Setup

To develop Homebridge plugins, ensure that Node.js version 20 or later is installed, along with a modern code editor such as [VS Code](https://code.visualstudio.com/). This plugin utilizes [TypeScript](https://www.typescriptlang.org/) for an enhanced development experience and includes pre-configured settings for [VS Code](https://code.visualstudio.com/) and ESLint. If you are using VS Code, please install the following extension:

- [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)

### Contributing

To contribute to the development of this plugin, please follow these steps:

1. Fork the repository.
2. Create a new branch for your feature or bug fix.
3. Implement your changes and commit them with a descriptive message.
4. Push your changes to your fork.
5. Create a pull request to the main repository.

### License

This project is licensed under the ISC License. Refer to the LICENSE file for more details.
