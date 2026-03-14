'use strict';

/* globals form morseuci morseui network rpc uci widgets wizard */
'require form';
'require uci';
'require network';
'require rpc';
'require tools.widgets as widgets';
'require tools.morse.wizard as wizard';
'require tools.morse.morseui as morseui';
'require tools.morse.uci as morseuci';

const callIwinfoInfo = rpc.declare({
	object: 'iwinfo',
	method: 'info',
	params: ['device'],
	expect: { '': {} },
});

function looksLikeMeshCapableRadio(wifiDevice, iwinfo) {
	const infoText = JSON.stringify(iwinfo ?? {}).toLowerCase();
	const raw = `${wifiDevice.path ?? ''} ${wifiDevice.htmode ?? ''} ${wifiDevice.hwmode ?? ''} ${wifiDevice.band ?? ''}`.toLowerCase();

	// Prefer strong positive hardware hints for the common Wi-Fi-only mesh cards.
	if (/mt7915|mt7916/.test(infoText) || /mt7915|mt7916/.test(raw)) {
		return true;
	}

	// HE modes are a practical hint for newer mac80211 radios where mesh is expected.
	if ((wifiDevice.htmode ?? '').toUpperCase().startsWith('HE')) {
		return true;
	}

	// Fallback to broader capability hint from iwinfo if available.
	return /\bax\b/.test(infoText);
}

function meshBackhaulPreference(wifiDevice) {
	// Range-first default: prefer 2.4 GHz, then 5 GHz, then 6 GHz.
	// Unknown bands are least preferred.
	const band = (wifiDevice.band ?? '').toLowerCase();
	if (band === '2g') {
		return 0;
	} else if (band === '5g') {
		return 1;
	} else if (band === '6g') {
		return 2;
	}

	return 9;
}

return wizard.AbstractWizardView.extend({
	__init__(/* ... */) {
		return this.super('__init__', this.varargs(arguments, 1,
			_('802.11s Mesh Wizard'),
			_(`<p>This wizard will guide you in setting up this device as part of an 802.11s mesh.
				<p>You can exit now if you prefer to complete your configuration manually.</p>`),
			'morse-config-diagram',
			new form.Map('wireless')));
	},

	getExtraConfigFiles() {
		return ['mesh11sd'];
	},

	loadWizardOptions() {
		const {
			wifiDevices,
			morseInterfaceName,
		} = wizard.readSectionInfo();

		const ahwlanZone = morseuci.getZoneForNetwork('ahwlan');
		const lanZone = morseuci.getZoneForNetwork('lan');
		const forwardsLanToAhwlan = uci.sections('firewall', 'forwarding').some(f => f.src === lanZone && f.dest === ahwlanZone && f.enabled !== '0');

		const {
			ethDHCPNetwork,
			ethDHCPPort,
			ethStaticNetwork,
		} = wizard.readEthernetPortInfo(this.getEthernetPorts());

		// If we weren't a mesh gate, force choice again.
		const getUplink = () => {
			if (uci.get('wireless', morseInterfaceName, 'mode') !== 'mesh') {
				return undefined;
			} else if (uci.get('mesh11sd', 'mesh_params', 'mesh_gate_announcements') !== '1') {
				return undefined;
			}

			for (const wifiDevice of wifiDevices) {
				// Return the first device setup as a station as the uplink
				if (uci.get('wireless', wifiDevice.staInterfaceName) && uci.get('wireless', wifiDevice.staInterfaceName, 'disabled') !== '1') {
					return `wifi-${wifiDevice.staInterfaceName}`;
				}
			}

			if (ethDHCPNetwork) {
				if (this.ethernetPorts.length > 1) {
					return `ethernet-${ethDHCPPort}`;
				} else {
					return 'ethernet';
				}
			} else if (ethStaticNetwork !== uci.get('wireless', morseInterfaceName, 'network')) {
				// HaLow is separate to ethernet, but there's no ethernet DHCP client.
				// This is probably like 'none'.
				return 'none';
			} else {
				// Note that this captures the default OpenWrt, where the AP and ethernet port
				// are on the same network and there's a DHCP server, but we don't support this mode
				// in the wizard.
				return undefined;
			}
		};

		// If we weren't a mesh gate or our uplink wasn't ethernet, force choice again.
		const getDeviceModeMeshGate = () => {
			if (getUplink()?.includes('ethernet')) {
				if (ethDHCPNetwork === uci.get('wireless', morseInterfaceName, 'network')) {
					return 'bridge';
				} else if (ethDHCPNetwork === 'wan' && this.ethernetPorts.length > 1) {
					return 'router_firewall';
				} else {
					return 'router';
				}
			} else {
				return undefined;
			}
		};

		// If we weren't a mesh point, force choice again.
		const getDeviceModeMeshPoint = () => {
			if (uci.get('wireless', morseInterfaceName, 'mode') !== 'mesh') {
				return undefined;
			} else if (uci.get('mesh11sd', 'mesh_params', 'mesh_gate_announcements') !== '0') {
				return undefined;
			} else if (ethStaticNetwork === 'lan') {
				return forwardsLanToAhwlan ? 'extender' : 'none';
			} else if (ethDHCPNetwork === uci.get('wireless', morseInterfaceName, 'network')) {
				return 'bridge';
			} else {
				return undefined;
			}
		};

		uci.add('network', 'wizard', 'wizard');
		uci.set('network', 'wizard', 'device_mode_meshgate', getDeviceModeMeshGate());
		uci.set('network', 'wizard', 'device_mode_meshpoint', getDeviceModeMeshPoint());
		uci.set('network', 'wizard', 'uplink', getUplink());
	},

	/* Handle complex config here. Basic wifi setup is covered by the usual UCI actions.
	 * We pass this through to morseconf.js so our 'complex' setup is shared.
	 * Like the standard OpenWrt parse, this _also_ does uci.set
	 * (but does not uci.save).
	 */
	parseWizardOptions() {
		// Clear out any network stuff we've created from alternative sets of options
		// so we don't have to consider as many alternative cases.
		wizard.resetUciNetworkTopology();

		const {
			wifiDevices,
			morseDeviceName,
			morseInterfaceName,
			morseMeshApInterfaceName,
			lanIp,
			wlanIp,
		} = wizard.readSectionInfo();

		wizard.setupNetworkIface('lan', { local: true });
		wizard.setupNetworkIface('ahwlan', { local: true, primaryLocal: true });
		// Force wan even if not using to make sure that wan firewall rules are retained
		// (resetUciNetworkTopology removes).
		wizard.setupNetworkIface('wan');

		// Extract values then remove from dummy uci section.
		const device_mode_meshgate = uci.get('network', 'wizard', 'device_mode_meshgate');
		const device_mode_meshpoint = uci.get('network', 'wizard', 'device_mode_meshpoint');
		let uplink = uci.get('network', 'wizard', 'uplink');

		let isMeshGate = uci.get('mesh11sd', 'mesh_params', 'mesh_gate_announcements') === '1';
		let isMeshAp = uci.get('wireless', morseMeshApInterfaceName, 'disabled') !== '1';

		const wifiApsEnabled = {};
		for (const wifiDevice of wifiDevices) {
			const radioRole = uci.get('network', 'wizard', `wifi_role_${wifiDevice.name}`) || 'ap';
			const meshSelected = radioRole === 'mesh' && this.wifiMeshCapabilities?.[wifiDevice.name];

			// Record whether each device has an enabled AP
			wifiApsEnabled[wifiDevice.name] = !meshSelected && uci.get('wireless', wifiDevice.apInterfaceName, 'disabled') !== '1';

			// We don't have an explicit option for this, but it's determined by uplink.
			// And because uplink is a complex option that's not valid for clients and is resolved here...
			uci.set('wireless', wifiDevice.staInterfaceName, 'disabled',
				(!meshSelected && uplink === `wifi-${wifiDevice.staInterfaceName}`) ? '0' : '1');

			if (meshSelected) {
				// Reuse this radio's default AP iface as a non-HaLow mesh member.
				uci.unset('wireless', wifiDevice.apInterfaceName, 'disabled');
				uci.set('wireless', wifiDevice.apInterfaceName, 'mode', 'mesh');
				uci.set('wireless', wifiDevice.apInterfaceName, 'network', 'batmesh1');
				uci.set('wireless', wifiDevice.apInterfaceName, 'encryption', 'sae');
				uci.unset('wireless', wifiDevice.apInterfaceName, 'wds');
			} else {
				uci.set('wireless', wifiDevice.apInterfaceName, 'mode', 'ap');
			}
		}

		// Guard against stale conflicting state: mesh-role radios cannot also be Wi-Fi uplink.
		if (uplink?.startsWith('wifi-')) {
			const uplinkSta = uplink.slice('wifi-'.length);
			const uplinkDevice = wifiDevices.find(d => d.staInterfaceName === uplinkSta);
			if (uplinkDevice) {
				const role = uci.get('network', 'wizard', `wifi_role_${uplinkDevice.name}`) || 'ap';
				if (role === 'mesh' && this.wifiMeshCapabilities?.[uplinkDevice.name]) {
					uplink = 'none';
					uci.set('network', 'wizard', 'uplink', uplink);
				}
			}
		}

		uci.set('wireless', morseInterfaceName, 'mode', 'mesh');
		uci.set('wireless', morseInterfaceName, 'encryption', 'sae');
		uci.set('wireless', morseInterfaceName, 'beacon_int', '1000');
		uci.set('wireless', morseDeviceName, 'enable_mcast_whitelist', '0');
		uci.set('wireless', morseDeviceName, 'enable_mcast_rate_control', '1');
		uci.set('wireless', morseDeviceName, 'enable_ps', '0');
		uci.set('wireless', morseDeviceName, 'enable_dynamic_ps_offload', '0');
		uci.set('wireless', morseDeviceName, 'enable_twt', '0');

		const bridgeMode = () => {
			morseuci.setNetworkDevices('ahwlan', this.getEthernetPorts().map(p => p.device));
			uci.set('wireless', morseInterfaceName, 'network', 'ahwlan');
			uci.set('wireless', morseInterfaceName, 'wds', '1');

			if (isMeshAp) {
				uci.set('wireless', morseMeshApInterfaceName, 'network', 'ahwlan');
				uci.set('wireless', morseMeshApInterfaceName, 'wds', '1');
			}

			for (const wifiDevice of wifiDevices) {
				if (wifiApsEnabled[wifiDevice.name]) {
					uci.set('wireless', wifiDevice.apInterfaceName, 'network', 'ahwlan');
				}
			}

			morseuci.createOrRemoveBridgeAsNeeded('ahwlan');

			return 'ahwlan';
		};

		// i.e. lan = eth, ahwlan = halow
		const nonBridgeMode = () => {
			morseuci.setNetworkDevices('lan', this.getEthernetPorts().map(p => p.device));
			uci.set('wireless', morseInterfaceName, 'network', 'ahwlan');

			// Unlike the 'normal' wizard, if we're a mesh gate
			// NOT bridging ethernet/mesh we still bridge the APs.
			if (isMeshAp) {
				uci.set('wireless', morseMeshApInterfaceName, 'network', 'ahwlan');
				uci.set('wireless', morseMeshApInterfaceName, 'wds', '1');
			}

			for (const wifiDevice of wifiDevices) {
				if (wifiApsEnabled[wifiDevice.name]) {
					uci.set('wireless', wifiDevice.apInterfaceName, 'network', 'lan');
				}
			}

			morseuci.createOrRemoveBridgeAsNeeded('lan');
			morseuci.createOrRemoveBridgeAsNeeded('ahwlan');

			return { ethIface: 'lan', halowIface: 'ahwlan' };
		};

		// Set 'bridge/ip/gateway' etc. via uci,
		// based on the selected uplink and traffic mode
		if (isMeshGate) {
			if (uplink?.match(/ethernet/) && device_mode_meshgate?.match(/router/)) {
				// Network
				const upstreamNetwork = device_mode_meshgate === 'router_firewall' ? 'wan' : 'lan';
				if (upstreamNetwork === 'wan') {
					morseuci.getOrCreateForwarding('ahwlan', 'wan');
				} else {
					morseuci.getOrCreateForwarding('ahwlan', 'lan', 'mmrouter');
				}

				// Devices
				uci.set('wireless', morseInterfaceName, 'network', 'ahwlan');
				if (isMeshAp) {
					uci.set('wireless', morseMeshApInterfaceName, 'network', 'ahwlan');
					uci.set('wireless', morseMeshApInterfaceName, 'wds', '1');
				}
				for (const wifiDevice of wifiDevices) {
					if (wifiApsEnabled[wifiDevice.name]) {
						uci.set('wireless', wifiDevice.apInterfaceName, 'network', 'ahwlan');
					}
				}
				const [_, port] = uplink.split('-');
				if (port) {
					morseuci.setNetworkDevices(upstreamNetwork, [port]);
					morseuci.setNetworkDevices('ahwlan', this.getEthernetPorts().filter(p => p.device !== port).map(p => p.device));
				} else {
					morseuci.setNetworkDevices(upstreamNetwork, this.getEthernetPorts().map(p => p.device));
				}

				// Bridges
				morseuci.createOrRemoveBridgeAsNeeded(upstreamNetwork);
				morseuci.createOrRemoveBridgeAsNeeded('ahwlan');

				uci.set('network', upstreamNetwork, 'proto', 'dhcp');
				morseuci.setupNetworkWithDnsmasq('ahwlan', wlanIp, true, false);
			} else if (uplink === 'none') {
				const { ethIface, halowIface } = nonBridgeMode();

				// This is a weird overload of the var name
				morseuci.setupNetworkWithDnsmasq(ethIface, lanIp, false);
				morseuci.setupNetworkWithDnsmasq(halowIface, wlanIp, false);
			} else if (uplink?.match(/ethernet/) && device_mode_meshgate === 'bridge') {
				const iface = bridgeMode();

				uci.set('network', iface, 'proto', 'dhcp');
			} else if (uplink?.match(/wifi/)) {
				const iface = bridgeMode();

				wizard.setupNetworkIface('lan', { local: true });
				uci.set('network', 'lan', 'proto', 'dhcp');
				const [_, uplinkWifiStaInterfaceName] = uplink.split('-');
				uci.set('wireless', uplinkWifiStaInterfaceName, 'network', 'lan');
				morseuci.setupNetworkWithDnsmasq(iface, wlanIp);
				morseuci.getOrCreateForwarding(iface, 'lan', 'mmrouter');
			}
		} else {
			if (device_mode_meshpoint === 'extender') { // i.e. router
				const { ethIface, halowIface } = nonBridgeMode();

				morseuci.setupNetworkWithDnsmasq(halowIface, wlanIp);
				morseuci.setupNetworkWithDnsmasq(ethIface, lanIp);
				morseuci.getOrCreateForwarding(ethIface, halowIface, 'mmextender');
			} else if (device_mode_meshpoint === 'none') {
				const { ethIface, halowIface } = nonBridgeMode();

				uci.set('network', halowIface, 'proto', 'dhcp');
				morseuci.setupNetworkWithDnsmasq(ethIface, lanIp, false);
			} else if (device_mode_meshpoint === 'bridge') {
				uci.set('wireless', morseInterfaceName, 'wds', '1');
				const iface = bridgeMode();

				morseuci.setupNetworkWithDnsmasq(iface, wlanIp);
			}
		}
	},

	async loadPages() {
		// resetUci disables all wifi-ifaces, but we want to remember the state of these.
		const {
			wifiDevices,
			morseMeshApInterfaceName,
		} = wizard.readSectionInfo();

		await network.flushCache(true);
		const wifiNetworks = await network.getWifiNetworks();
		const wifiNetworksBySection = wifiNetworks.reduce((acc, wifiNetwork) => ({
			...acc,
			[wifiNetwork.getName()]: wifiNetwork,
		}), {});

		const wifiMeshCapabilities = {};
		const defaultWifiRoles = {};
		const wizardUsed = uci.get('luci', 'wizard', 'used') === '1';
		const meshCapableDevices = [];
		const existingMeshDevices = [];

		for (const wifiDevice of wifiDevices) {
			const runtimeIfname = wifiNetworksBySection[wifiDevice.apInterfaceName]?.getIfname()
				|| wifiNetworksBySection[wifiDevice.staInterfaceName]?.getIfname();
			let iwinfo = null;
			if (runtimeIfname) {
				iwinfo = await callIwinfoInfo(runtimeIfname).catch(() => null);
			}

			const existingMode = uci.get('wireless', wifiDevice.apInterfaceName, 'mode');
			wifiMeshCapabilities[wifiDevice.name] =
				existingMode === 'mesh' || looksLikeMeshCapableRadio(wifiDevice, iwinfo);
			if (wifiMeshCapabilities[wifiDevice.name]) {
				meshCapableDevices.push(wifiDevice);
			}
			if (existingMode === 'mesh') {
				existingMeshDevices.push(wifiDevice);
			}
		}

		const preferredMeshDevice = !wizardUsed && existingMeshDevices.length === 0
			? meshCapableDevices
				.toSorted((a, b) =>
					meshBackhaulPreference(a) - meshBackhaulPreference(b)
					|| a.name.localeCompare(b.name))[0]
			: null;

		for (const wifiDevice of wifiDevices) {
			const existingMode = uci.get('wireless', wifiDevice.apInterfaceName, 'mode');
			if (existingMode === 'mesh') {
				defaultWifiRoles[wifiDevice.name] = 'mesh';
			} else if (!wizardUsed && preferredMeshDevice && wifiDevice.name === preferredMeshDevice.name) {
				defaultWifiRoles[wifiDevice.name] = 'mesh';
			} else {
				defaultWifiRoles[wifiDevice.name] = 'ap';
			}
		}

		this.wifiMeshCapabilities = wifiMeshCapabilities;
		this.defaultWifiRoles = defaultWifiRoles;

		const wifiApsEnabled = wifiDevices.reduce((acc, wifiDevice) => ({
			...acc,
			[wifiDevice.name]: uci.get('wireless', wifiDevice.apInterfaceName, 'disabled') !== '1',
		}), {});
		return [
			wifiApsEnabled,
			uci.get('wireless', morseMeshApInterfaceName, 'disabled') === '1',
			wifiMeshCapabilities,
			defaultWifiRoles,
		];
	},

	renderPages([wifiApsEnabled, morseMeshApDisabled, wifiMeshCapabilities, defaultWifiRoles]) {
		let page, option;

		const map = this.map;
		const {
			wifiDevices,
			morseDeviceName,
			morseInterfaceName,
			morseMeshApInterfaceName,
		} = wizard.readSectionInfo();

		uci.unset('wireless', morseInterfaceName, 'disabled');

		for (const wifiDevice of wifiDevices) {
			// Remove any traces of the AP ever being disabled
			if (wifiApsEnabled[wifiDevice.name]) {
				uci.unset('wireless', wifiDevice.apInterfaceName, 'disabled');
			}

			uci.set('wireless', wifiDevice.apInterfaceName, 'device', wifiDevice.name);
			uci.set('wireless', wifiDevice.apInterfaceName, 'mode', 'ap');

			if (!uci.get('wireless', wifiDevice.staInterfaceName)) {
				uci.add('wireless', 'wifi-iface', wifiDevice.staInterfaceName);
			}
			uci.set('wireless', wifiDevice.staInterfaceName, 'device', wifiDevice.name);
			uci.set('wireless', wifiDevice.staInterfaceName, 'mode', 'sta');
		}

		// Create a morse AP config section for mesh gate configuration
		if (!uci.get('wireless', morseMeshApInterfaceName)) {
			uci.add('wireless', 'wifi-iface', morseMeshApInterfaceName);
			uci.set('wireless', morseMeshApInterfaceName, 'disabled', '1');
			uci.set('wireless', morseMeshApInterfaceName, 'ssid', morseuci.getDefaultSSID());
			uci.set('wireless', morseMeshApInterfaceName, 'key', morseuci.getDefaultWifiKey());
		} else if (!morseMeshApDisabled) {
			uci.unset('wireless', morseMeshApInterfaceName, 'disabled');
		}
		uci.set('wireless', morseMeshApInterfaceName, 'device', morseDeviceName);
		uci.set('wireless', morseMeshApInterfaceName, 'mode', 'ap');
		uci.set('wireless', morseMeshApInterfaceName, 'encryption', 'sae');

		const initialMorseMode = uci.get('wireless', morseInterfaceName, 'mode');
		if (initialMorseMode !== 'mesh') {
			// Remove mesh_gate_announcements to force user to choose.
			uci.unset('mesh11sd', 'mesh_params', 'mesh_gate_announcements');
			uci.set('wireless', morseInterfaceName, 'mode', 'mesh');
		}

		const morseDeviceSection = map.section(form.NamedSection, morseDeviceName, 'wifi-device');
		const morseMeshInterfaceSection = map.section(form.NamedSection, morseInterfaceName, 'wifi-interface');
		const morseApInterfaceSection = map.section(form.NamedSection, morseMeshApInterfaceName, 'wifi-interface');
		const wifiApInterfaceSections = {};
		for (const wifiDevice of wifiDevices) {
			wifiApInterfaceSections[wifiDevice.name] = map.section(form.NamedSection, wifiDevice.apInterfaceName, 'wifi-interface');
		}
		const meshParamsConfigSection = map.section(form.NamedSection, 'mesh_params', 'mesh11sd');
		meshParamsConfigSection.uciconfig = 'mesh11sd';
		// We put the network configuration in its own dummy section inside wireless.
		//
		// This means:
		//  - our dependencies work properly
		//  - the different map doesn't constrain our ui order
		//
		// All .load functions are overridden to figure it out based on the underlying
		// option values. In handleSave, we remove this section and only persist the related
		// options.
		const networkSection = map.section(form.NamedSection, 'wizard', 'wizard');
		networkSection.uciconfig = 'network';

		// Keeping a reference to the current AbstractWizardView for use in callbacks
		const thisWizardView = this;

		/*****************************************************************************/

		page = this.page(meshParamsConfigSection,
			'', _(`You can configure your device as a <b>Mesh Point</b> or a <b>Mesh Gate</b>, which is a Mesh Point with a co-located non-mesh network (e.g. an AP, an upstream Ethernet connection, etc.).`));

		const meshGateModeText = _(`An 802.11s <b>Mesh Gate</b> provides both a Mesh Point and a co-located non-mesh network (e.g. an AP, an upstream Ethernet connection, etc.). It broadcasts mesh gate announcements to help align the mesh nodes, making it easier for traffic to reach the non-mesh network.`);
		const meshStaModeText = _(`An 802.11s <b>Mesh Point</b> is a node in an 802.11s mesh network.`);

		page.enableDiagram({
			extras: ['GATE_SELECT_FILL', 'POINT_SELECT_FILL'],
			blacklist: [
				'GATE_UPLINK', 'GATE_UPLINK_WIFI', 'GATE_MGMT_ETH', 'GATE_UPLINK_ETH', 'GATE_WIFI', 'GATE_HALOW_MESH_INT', 'GATE_HALOW_AP',
				'POINT_HALOW_INT', 'POINT_MGMT_ETH', 'POINT_WIFI',
			],
		});

		option = page.option(form.ListValue, 'mesh_gate_announcements');
		option.displayname = _('Mesh Mode');
		option.widget = 'radio';
		option.orientation = 'vertical';
		option.value('0', _('Mesh Point'));
		option.value('1', _('Mesh Gate (Mesh Point with collocated network)'));
		option.rmempty = false;
		option.onchange = function (ev, sectionId, value) {
			if (value == '1') {
				this.page.updateInfoText(meshGateModeText, thisWizardView);
			} else if (value == '0') {
				this.page.updateInfoText(meshStaModeText, thisWizardView);
			}
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		/*****************************************************************************/

		page = this.page(morseMeshInterfaceSection,
			_('Setup Mesh Network'),
			_(`All devices in the mesh must have the same <b>Mesh ID</b>, which is a arbitrary string that identifies the mesh similar to an SSID.`));
		page.enableDiagram({
			extras: ['POINT_HALOW_INT_SELECT', 'GATE_HALOW_MESH_INT_SELECT', 'POINT_HALOW_INT_SELECT_FILL', 'GATE_HALOW_MESH_INT_SELECT_FILL'],
			blacklist: [
				'GATE_UPLINK', 'GATE_UPLINK_WIFI', 'GATE_MGMT_ETH', 'GATE_UPLINK_ETH', 'GATE_WIFI', 'GATE_HALOW_AP',
				'POINT_MGMT_ETH', 'POINT_WIFI',
				'POINT_HALOW_INT:SSID', 'POINT_HALOW_INT:IP', 'POINT_HALOW_INT:IPMethod',
				'GATE_HALOW_MESH_INT:SSID', 'GATE_HALOW_MESH_INT:IP', 'GATE_HALOW_MESH_INT:IPMethod',
			],
		});

		option = page.option(form.Value, 'mesh_id', _('Mesh ID'));
		option.datatype = 'maxlength(32)';
		option.rmempty = false;
		option.retain = true;
		option.onchange = function () {
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};
		option.load = sectionId => uci.get('wireless', sectionId, 'mesh_id') || 'openmanet';
		option.forcewrite = true; // Required since our load doesn't reflect uci.

		option = page.option(form.Value, 'key', _('Mesh Passphrase'));
		option.datatype = 'wpakey';
		option.password = true;
		option.rmempty = false;
		option.retain = true;
		option.load = sectionId =>
			(initialMorseMode === 'mesh' && uci.get('wireless', sectionId, 'key')) || 'changeme123';
		option.forcewrite = true; // Required since our load doesn't reflect uci.

		option = page.option(widgets.WifiFrequencyValue, '_freq', '<br />' + _('Operating Frequency'));
		option.ucisection = morseDeviceName;
		option.rmempty = false;
		option.retain = true;

		/*****************************************************************************/

		// Device mode for Mesh Point only.
		// i.e. if we're a Mesh Point, we call it an 'extender'.
		// This echoes the usual AP/STA terminology.
		page = this.page(networkSection,
			_('Traffic Mode'),
			_(`We recommend configuring this device as a <b>Bridge</b> All other modes are currently disabled.
				<p>In <b>Bridge</b> mode, the non-HaLow devices obtain IP addresses from your Mesh Point.
				The address range is within the OpenMANET HaLow network range (10.41.0.0/16).

				<p>To create a separate network for the HaLow and the non-HaLow devices select <b>Extender</b>.
				In which case, this device will run a DHCP server on the non-HaLow interfaces, and
				it will use NAT to forward IP traffic between HaLow and non-HaLow networks.

				<p>Choose <b>None</b> to keep the HaLow and non-HaLow networks isolated,
				this is the mode the device uses after factory reset.`));
		var noneInfoSta = _(`In <b>None</b> traffic mode, non-HaLow and HaLow networks are isolated.
			This device will use a static IP address and run a DHCP server on the non-HaLow interface.`);
		var bridgeInfoSta = _(`In <b>Bridged</b> traffic mode, non-HaLow devices obtain IPs from your HaLow link.`);
		var extenderInfoSta = _(`In <b>Extender</b> traffic mode, non-HaLow devices obtain IPs from the DHCP server
			on this device and this device uses NAT to forward IP traffic.`);

		page.enableDiagram({
			extras: [
				'POINT_HALOW_INT_SELECT', 'POINT_HALOW_INT_SELECT_FILL',
				'POINT_MGMT_ETH_INT_SELECT', 'POINT_MGMT_ETH_INT_SELECT_FILL',
			],
			blacklist: [
				'POINT_WIFI',
			],
		});

		option = page.option(form.ListValue, 'device_mode_meshpoint');
		option.displayname = _('Traffic mode');
		option.depends(`mesh11sd.mesh_params.mesh_gate_announcements`, '0');
		option.rmempty = false;
		option.retain = true;
		option.widget = 'radio';
		option.orientation = 'vertical';
		option.default = 'bridge';
		option.readonly = true;
		option.value('none', _('None'));
		option.value('bridge', _('Bridge'));
		option.value('extender', _('Extender'));
		option.onchange = function (ev, sectionId, value) {
			if (value == 'bridge') {
				this.page.updateInfoText(bridgeInfoSta, thisWizardView);
			} else if (value == 'extender') {
				this.page.updateInfoText(extenderInfoSta, thisWizardView);
			} else if (value == 'none') {
				this.page.updateInfoText(noneInfoSta, thisWizardView);
			}
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		/*****************************************************************************/

		var ethInfoAp = _(`If you use an <b>Ethernet</b> upstream, we recommend choosing <b>Router</b>.
			In <b>Router</b> mode the HaLow connected devices obtain IP addresses from
			the DHCP server on this device, and this device uses NAT to forward IP traffic.`);
		var wifiInfoAp = _(`If you use a <b>Wi-Fi</b> upstream, fill in the Wi-Fi AP credentials.
			The HaLow connected devices obtain IP addresses from the DHCP server on this device,
			and this device uses NAT to forward IP traffic.`);
		var noneInfoAp = _(`In <b>None</b> mode, your device will have a static IP address and run a
			DHCP server on all interfaces, the HaLow and non-HaLow networks will be isolated from each other.`);
		var routerInfoAp = _(`In <b>Router</b> mode the HaLow connected devices obtain IP addresses from
			the DHCP server on this device, and this device uses NAT to forward IP traffic. <strong>Only use this if you
			intend to connect to a trusted network</strong>, as this admin interface
			will be accessible on the upstream network.`);
		var routerFirewallInfoAp = _(`In <b>Router with Firewall</b> mode the HaLow connected devices obtain IP addresses from
			the DHCP server on this device, and this device uses NAT to forward IP traffic. The admin interface
			will be blocked on the network you connect to, which is the normal behaviour for a home router. 
			Choose this when connecting directly to the internet.`);

		page = this.page(networkSection,
			_('Upstream Network'),
			_(`You are using this HaLow device as a mesh gate, you should configure how it
			connects to the internet (or some other network).
			<p>
			If you choose <b>None</b>, your device will have a static IP address and run a DHCP server on all interfaces,
			the HaLow and non-HaLow networks will be isolated from each other.
			If you choose an upstream network, your HaLow and non-HaLow networks will be connected.
			</p>`));
		page.enableDiagram({
			extras: [
				'GATE_MGMT_ETH_INT_SELECT', 'GATE_MGMT_ETH_INT_SELECT_FILL',
				'GATE_UPLINK_ETH_INT_SELECT', 'GATE_UPLINK_ETH_INT_SELECT_FILL',
				'GATE_HALOW_MESH_INT_SELECT', 'GATE_HALOW_MESH_INT_SELECT_FILL',
				'GATE_UPLINK_WIFI_INT_SELECT', 'GATE_UPLINK_WIFI_INT_SELECT_FILL'],
			blacklist: ['GATE_WIFI', 'GATE_HALOW_AP'],
		});

		option = page.option(form.ListValue, 'uplink');
		option.displayname = _('Upstream network');
		option.depends(`mesh11sd.mesh_params.mesh_gate_announcements`, '1');
		option.rmempty = false;
		option.widget = 'radio';
		option.orientation = 'vertical';
		option.value('none', _('None'));
		if (this.getEthernetPorts().length === 1) {
			option.value('ethernet', _('Ethernet'));
		} else if (this.getEthernetPorts().length > 1) {
			const nonDonglePorts = [];
			for (const port of this.getEthernetPorts()) {
				if (!port.builtin) {
					option.value(`ethernet-${port.device}`, `Dongle (${port.device}) - e.g. a USB LTE dongle or tethered phone`);
				} else {
					nonDonglePorts.push(port);
				}
			}

			// Put the non-dongle ports at the end, as dongle is preferred.
			for (const port of nonDonglePorts) {
				option.value(`ethernet-${port.device}`, `Ethernet (${port.device})`);
			}
		}

		for (const wifiDevice of wifiDevices) {
			const displayName = wifiDevices.length > 1
				? `${wifiDevice.getBandName()} Wi-Fi (${wifiDevice.name})`
				: `${wifiDevice.getBandName()} Wi-Fi`;
			option.value(`wifi-${wifiDevice.staInterfaceName}`, displayName);
		}
		option.validate = function (_sectionId, value) {
			if (value?.startsWith('wifi-')) {
				const staIfaceName = value.slice('wifi-'.length);
				const selectedWifiDevice = wifiDevices.find(d => d.staInterfaceName === staIfaceName);
				if (selectedWifiDevice) {
					const role = uci.get('network', 'wizard', `wifi_role_${selectedWifiDevice.name}`) || 'ap';
					if (role === 'mesh' && wifiMeshCapabilities?.[selectedWifiDevice.name]) {
						return _('Selected Wi-Fi radio is configured as Mesh Point. Choose another uplink, or switch that radio role to Access Point.');
					}
				}
			}
			return true;
		};
		option.onchange = function (ev, sectionId, value) {
			if (value.includes('ethernet')) {
				this.page.updateInfoText(ethInfoAp, thisWizardView);
			} else if (value.includes('wifi')) {
				this.page.updateInfoText(wifiInfoAp, thisWizardView);
			} else if (value == 'none') {
				this.page.updateInfoText(noneInfoAp, thisWizardView);
			}
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		for (const wifiDevice of wifiDevices) {
			option = page.option(morseui.SSIDListScan, `uplink_ssid-${wifiDevice.staInterfaceName}`, _('<abbr title="Service Set Identifier">SSID</abbr>'));
			// Have to be explicit here because we change uciconfig/section/option.
			option.depends('network.wizard.uplink', `wifi-${wifiDevice.staInterfaceName}`);
			if (wifiMeshCapabilities?.[wifiDevice.name]) {
				option.depends(`network.wizard.wifi_role_${wifiDevice.name}`, 'ap');
			}
			option.uciconfig = 'wireless';
			option.ucisection = wifiDevice.staInterfaceName;
			option.ucioption = 'ssid';
			option.staOnly = true;
			option.scanAlerts = true;
			option.rmempty = false;
			option.retain = true;
			option.scanEncryptions = ['psk2', 'psk', 'sae', 'owe', 'none'];
			option.onchangeWithEncryption = function (ev, sectionId, value, encryption) {
				thisWizardView.onchangeOptionUpdateDiagram(this);
				this.section.getUIElement(sectionId, `uplink_encryption-${wifiDevice.staInterfaceName}`).setValue(encryption);
				this.section.getUIElement(sectionId, `uplink_key-${wifiDevice.staInterfaceName}`).setValue('');
			};

			// Non-HaLow wifi credentials are one of the few things we don't want to retain,
			// as users might be putting more sensitive creds here
			// (i.e. if you disable, this should disappear).
			option = page.option(form.ListValue, `uplink_encryption-${wifiDevice.staInterfaceName}`, _('Encryption'));
			option.uciconfig = 'wireless';
			option.ucisection = wifiDevice.staInterfaceName;
			option.ucioption = 'encryption';
			option.depends('network.wizard.uplink', `wifi-${wifiDevice.staInterfaceName}`);
			if (wifiMeshCapabilities?.[wifiDevice.name]) {
				option.depends(`network.wizard.wifi_role_${wifiDevice.name}`, 'ap');
			}
			option.value('psk2', _('WPA2-PSK'));
			option.value('sae', _('WPA3-SAE'));
			option.value('psk', _('WPA-PSK'));
			option.value('owe', _('OWE'));
			option.value('none', _('None'));

			option = page.option(form.Value, `uplink_key-${wifiDevice.staInterfaceName}`, _('Passphrase'));
			// Have to be explicit here because we change uciconfig/section/option.
			option.depends(`wireless.wizard.uplink_encryption-${wifiDevice.staInterfaceName}`, 'psk');
			option.depends(`wireless.wizard.uplink_encryption-${wifiDevice.staInterfaceName}`, 'psk2');
			option.depends(`wireless.wizard.uplink_encryption-${wifiDevice.staInterfaceName}`, 'sae');
			option.depends('network.wizard.uplink', `wifi-${wifiDevice.staInterfaceName}`);
			if (wifiMeshCapabilities?.[wifiDevice.name]) {
				option.depends(`network.wizard.wifi_role_${wifiDevice.name}`, 'ap');
			}
			option.uciconfig = 'wireless';
			option.ucisection = wifiDevice.staInterfaceName;
			option.ucioption = 'key';
			option.datatype = 'wpakey';
			option.password = true;
		}

		option = page.heading(_('Traffic Mode'));
		option.depends({ uplink: /ethernet/ });

		option = page.option(form.ListValue, 'device_mode_meshgate');
		option.displayname = _('Bridge/Router');
		option.depends({ uplink: /ethernet/ });
		option.rmempty = false;
		option.retain = true;
		option.widget = 'radio';
		option.orientation = 'vertical';
		option.default = 'router';
		option.readonly = true;
		option.value('router', _('Router'));
		if (this.getEthernetPorts().length > 1) {
			// Only offer the firewall option if you have multiple ethernet ports
			// (with a single ethernet port, you're much more likely to get
			// locked out of the admin interface).
			option.value('router_firewall', _('Router with Firewall'));
		}
		option.onchange = function (ev, sectionId, value) {
			if (value == 'router') {
				this.page.updateInfoText(routerInfoAp, thisWizardView);
			} else if (value == 'router_firewall') {
				this.page.updateInfoText(routerFirewallInfoAp, thisWizardView);
			}
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		/*****************************************************************************/

		/*****************************************************************************/

		for (const wifiDevice of wifiDevices) {
			const roleOptionName = `wifi_role_${wifiDevice.name}`;
			const meshIdOptionName = `mesh_id_${wifiDevice.name}`;
			const meshKeyOptionName = `mesh_key_${wifiDevice.name}`;
			const meshSupported = !!wifiMeshCapabilities?.[wifiDevice.name];

			page = this.page(wifiApInterfaceSections[wifiDevice.name],
				`${wifiDevice.getBandName()} Wi-Fi Access Point`,
				meshSupported
					? `This ${wifiDevice.getBandName()} radio supports 802.11s mesh and is preselected as a <b>Mesh Point</b> for Wi-Fi-only mesh backhaul. You can switch it back to <b>Access Point</b> mode if preferred.`
					: `This HaLow device is also capable of ${wifiDevice.getBandName()} Wi-Fi.
					If you enable a ${wifiDevice.getBandName()} Wi-Fi <b>Access Point</b>, you will be able to
					connect ${wifiDevice.getBandName()} Wi-Fi clients to this device.`);
			page.enableDiagram({
				extras: ['GATE_WIFI_INT_SELECT', 'GATE_WIFI_INT_SELECT_FILL',
				         'POINT_WIFI_INT_SELECT', 'POINT_WIFI_INT_SELECT_FILL'],
			});

			if (meshSupported) {
				option = page.option(form.ListValue, roleOptionName, _('Radio role'));
				option.uciconfig = 'network';
				option.ucisection = 'wizard';
				option.ucioption = roleOptionName;
				option.widget = 'radio';
				option.orientation = 'vertical';
				option.rmempty = false;
				option.retain = true;
				option.value('mesh', _('Mesh Point (preselected)'));
				option.value('ap', _('Access Point'));
				option.load = () => uci.get('network', 'wizard', roleOptionName) || defaultWifiRoles[wifiDevice.name] || 'ap';
				option.write = (_sectionId, value) => uci.set('network', 'wizard', roleOptionName, value);
				option.onchange = function () {
					thisWizardView.onchangeOptionUpdateDiagram(this);
				};
			} else {
				option = page.message(_('This radio does not advertise 802.11s mesh capability in this build, so it is configured as Access Point only.'), 'notice');
			}

			option = page.option(morseui.Slider, 'disabled', `Enable ${wifiDevice.getBandName()} Access Point`);
			option.enabled = '0';
			option.disabled = '1';
			option.default = '0';
			if (meshSupported) {
				option.depends(`network.wizard.${roleOptionName}`, 'ap');
			}
			option.onchange = function () {
				thisWizardView.onchangeOptionUpdateDiagram(this);
			};

			option = page.option(form.Value, 'ssid', _('<abbr title="Service Set Identifier">SSID</abbr>'));
			option.datatype = 'maxlength(32)';
			option.retain = true;
			option.rmempty = false;
			option.depends('disabled', '0');
			if (meshSupported) {
				option.depends(`network.wizard.${roleOptionName}`, 'ap');
			}
			option.onchange = function () {
				thisWizardView.onchangeOptionUpdateDiagram(this);
			};

			option = page.option(form.Value, 'key', _('Passphrase'));
			option.datatype = 'wpakey';
			option.password = true;
			option.retain = true;
			option.rmempty = false;
			option.depends('disabled', '0');
			if (meshSupported) {
				option.depends(`network.wizard.${roleOptionName}`, 'ap');
			}

			option = page.option(form.ListValue, 'encryption', _('Encryption'));
			option.value('psk2', _('WPA2-PSK'));
			option.value('sae-mixed', _('WPA2-PSK/WPA3-SAE Mixed Mode'));
			option.value('sae', _('WPA3-SAE'));
			option.depends('disabled', '0');
			if (meshSupported) {
				option.depends(`network.wizard.${roleOptionName}`, 'ap');
			}

			if (meshSupported) {
				option = page.option(form.Value, meshIdOptionName, _('Mesh ID'));
				option.uciconfig = 'wireless';
				option.ucisection = wifiDevice.apInterfaceName;
				option.ucioption = 'mesh_id';
				option.datatype = 'maxlength(32)';
				option.rmempty = false;
				option.retain = true;
				option.depends(`network.wizard.${roleOptionName}`, 'mesh');
				option.load = sectionId => uci.get('wireless', sectionId, 'mesh_id') || morseuci.getDefaultSSID();
				option.write = (sectionId, value) => uci.set('wireless', sectionId, 'mesh_id', value);
				option.onchange = function () {
					thisWizardView.onchangeOptionUpdateDiagram(this);
				};

				option = page.option(form.Value, meshKeyOptionName, _('Mesh Passphrase'));
				option.uciconfig = 'wireless';
				option.ucisection = wifiDevice.apInterfaceName;
				option.ucioption = 'key';
				option.datatype = 'wpakey';
				option.password = true;
				option.rmempty = false;
				option.retain = true;
				option.depends(`network.wizard.${roleOptionName}`, 'mesh');
				option.load = sectionId => uci.get('wireless', sectionId, 'key') || morseuci.getDefaultWifiKey();
				option.write = (sectionId, value) => uci.set('wireless', sectionId, 'key', value);
			}
		}

		/*****************************************************************************/

		// We don't actually modify morseInterfaceSection here, but it makes it easier
		// to get to our most common dependencies.
		page = this.page(morseMeshInterfaceSection,
			_('Almost there...'),
			_(`Click <b>Apply</b> to persist your configuration.`));
		// This last page should always be active, as otherwise when initial config is happening
		// none of the options are visible and it's treated as inactive.
		page.isActive = () => true;
		page.enableDiagram();

		option = page.html(() => this.renderIPChangeAlert());

		for (const wifiDevice of wifiDevices) {
			option = page.step(`
				Connect another device via <b>${wifiDevice.getBandName()} Wi-Fi</b> to use your new HaLow link.
			`);
			option.depends({ mode: 'sta', [`wireless.${wifiDevice.apInterfaceName}.disabled`]: '0' });
			if (wifiMeshCapabilities?.[wifiDevice.name]) {
				option.depends(`network.wizard.wifi_role_${wifiDevice.name}`, 'ap');
			}
		}

		// AP steps
		//
		option = page.step(_(`
			Connect this device to your existing network via an Ethernet cable.
		`));
		option.depends('network.wizard.uplink', /ethernet/);

		for (const wifiDevice of wifiDevices) {
			option = page.step(_(`
				Connect ${wifiDevice.getBandName()} devices to your network.
			`));
			option.depends({ mode: 'ap', [`wireless.${wifiDevice.apInterfaceName}.disabled`]: '0' });
			if (wifiMeshCapabilities?.[wifiDevice.name]) {
				option.depends(`network.wizard.wifi_role_${wifiDevice.name}`, 'ap');
			}
		}

		option = page.step(_(`
			Connect Ethernet devices to your network.
		`));
		option.depends('network.wizard.uplink', /wifi/);
		option.depends('network.wizard.uplink', 'none');

		option = page.step(_(`For advanced 802.11s mesh settings, you can navigate to Network->Wireless page once you exit the wizard`));
		option = page.step(_(`B.A.T.M.A.N for 802.11s mesh is setup automatically`));

		/*****************************************************************************/

		page = this.page(morseDeviceSection, '');

		// This last page should always be active, as otherwise when initial config is happening
		// none of the options are visible and it's treated as inactive.
		page.isActive = () => true;

		page.html(() => E('span', { class: 'completion' }, [
			this.renderIPChangeAlert(),
			E('h1', _('Wizard Complete')),
			E('p', _('Click below to exit the wizard')),
		]));

		return map.render();
	},

	updateChannelOptions(country, bandwidth) {
		this.channelOption.clear();
		for (const channel of this.countryChannels[country][bandwidth]) {
			this.channelOption.value(channel.s1g_chan, `${channel.s1g_chan} (${channel.centre_freq_mhz} MHz)`);
		}
	},
});
