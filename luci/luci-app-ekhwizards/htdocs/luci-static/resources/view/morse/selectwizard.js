/**
 * Wizard selection page.
 */
/* globals uci view wizard */
'require view';
'require tools.morse.wizard as wizard';
'require uci';

return view.extend({
	async load() {
		const closeButton = document.querySelector('body header button.close');
		closeButton.onclick = () => this.abort();
		return await Promise.all([
			//uci.load('prplmesh').then(() => true).catch(() => false),
			uci.load('mesh11sd').then(() => true).catch(() => false),
			//uci.load('matter').then(() => true).catch(() => false),
			uci.load('luci'),
			uci.load('wireless').catch(() => null),
		]);
	},

	async abort() {
		if ([L.env.requestpath.join('/'), 'admin/selectwizard'].includes(uci.get('luci', 'main', 'homepage'))) {
			await wizard.directUciRpc.delete('luci', 'main', 'homepage');
			await wizard.directUciRpc.commit('luci');
		}
		window.location.href = L.url();
	},

	card(url, heading, text, picture) {
		return E('a', { class: 'card', href: url }, [
			E('h3', heading),
			E('img', { src: picture }),
			E('p', text),
		]);
	},

	render([hasMesh11sd]) {
		const hasMorse = uci.sections('wireless', 'wifi-device').some(s => s.type === 'morse');
		if (!hasMorse) {
			if (!this.noMorseRedirectScheduled) {
				this.noMorseRedirectScheduled = true;
				window.setTimeout(() => { window.location.href = L.url('admin', 'network', 'wireless'); }, 1500);
			}

			return E('div', { class: 'wizard-contents' }, [
				E('h2', _('Wi-Fi Setup')),
				E('p', _('No HaLow radio was detected. Redirecting to standard Wi-Fi configuration.')),
				E('div', [
					E('a', {
						class: 'cbi-button cbi-button-action',
						href: L.url('admin', 'network', 'wireless'),
					}, _('Open Wireless Configuration')),
				]),
			]);
		}

		const cards = [];
		if (hasMesh11sd) {
			cards.push(this.card(
				L.url('admin', 'morse', 'meshwizard'),
				_('802.11s Mesh'),
				_('Setup your device as part of an 802.11s Mesh (either as a Mesh Point or a Mesh Gate).'),
				L.resourceCacheBusted('view/morse/images/meshwizard.svg'),
			));
		}
		return E('div', { class: 'wizard-contents' }, [
			E('h2', _('Select a Wizard')),
			cards.length > 0
				? E('div', { class: 'cards' }, cards)
				: E('div', [
					E('p', _('No HaLow wizard options are currently available.')),
					E('a', {
						class: 'cbi-button cbi-button-action',
						href: L.url('admin', 'network', 'wireless'),
					}, _('Open Wireless Configuration')),
				]),
		]);
	},

	/**
	 * Usually, addFooter deals with handleSave etc.
	 *
	 * Because we're copying the wizard approach and want to use the wizard.css,
	 * we override this to create a 'wizard-style' footer.
	 *
	 * @override
	 */
	addFooter() {
		return E('div', [
			E('div', { class: 'container' }),
		]);
	},
});
