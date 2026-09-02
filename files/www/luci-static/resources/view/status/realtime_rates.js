'use strict';
'require view';
'require fs';
'require network';
'require dom';
'require poll';

var prevStats = {};
var lastTimestamp = null;
var hostsMap = {};

function formatSpeed(bps) {
	if (!bps || isNaN(bps) || bps <= 0) return '0.00 Kbps';
	var bits = bps * 8;
	if (bits >= 1000000) {
		return (bits / 1000000).toFixed(2) + ' Mbps';
	} else if (bits >= 1000) {
		return (bits / 1000).toFixed(1) + ' Kbps';
	}
	return bits.toFixed(0) + ' bps';
}

function formatBytes(bytes) {
	if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
	if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
	if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
	if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
	return bytes + ' B';
}

return view.extend({
	load: function() {
		return network.getHostHints().then(function(hints) {
			if (hints && hints.hosts) {
				for (var mac in hints.hosts) {
					var h = hints.hosts[mac];
					if (h.ipaddrs) {
						for (var i = 0; i < h.ipaddrs.length; i++) {
							hostsMap[h.ipaddrs[i]] = h.name || mac;
						}
					}
				}
			}
		});
	},

	render: function() {
		var viewNode = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Live Client Speeds (Canlı Cihaz Hızları)')),
			E('div', { 'class': 'cbi-map-descr' }, _('Ağdaki her cihazın o saniyedeki anlık indirme (Download) ve yükleme (Upload) hızlarını canlı gösterir.')),

			// Summary Cards
			E('div', { 'style': 'display: flex; gap: 15px; margin-bottom: 20px; flex-wrap: wrap;' }, [
				E('div', { 'class': 'cbi-section', 'style': 'flex: 1; min-width: 240px; padding: 15px; border-radius: 8px; background: rgba(0, 180, 216, 0.1); border: 1px solid rgba(0, 180, 216, 0.3); text-align: center;' }, [
					E('div', { 'style': 'font-size: 13px; color: #888; font-weight: bold; text-transform: uppercase;' }, '⚡ Toplam İndirme Hızı (Download)'),
					E('div', { 'id': 'total-dl-speed', 'style': 'font-size: 28px; font-weight: bold; color: #00b4d8; margin-top: 5px;' }, '0.00 Mbps')
				]),
				E('div', { 'class': 'cbi-section', 'style': 'flex: 1; min-width: 240px; padding: 15px; border-radius: 8px; background: rgba(247, 127, 0, 0.1); border: 1px solid rgba(247, 127, 0, 0.3); text-align: center;' }, [
					E('div', { 'style': 'font-size: 13px; color: #888; font-weight: bold; text-transform: uppercase;' }, '🚀 Toplam Yükleme Hızı (Upload)'),
					E('div', { 'id': 'total-ul-speed', 'style': 'font-size: 28px; font-weight: bold; color: #f77f00; margin-top: 5px;' }, '0.00 Mbps')
				]),
				E('div', { 'class': 'cbi-section', 'style': 'flex: 1; min-width: 200px; padding: 15px; border-radius: 8px; background: rgba(106, 76, 147, 0.1); border: 1px solid rgba(106, 76, 147, 0.3); text-align: center;' }, [
					E('div', { 'style': 'font-size: 13px; color: #888; font-weight: bold; text-transform: uppercase;' }, '📱 Aktif İstemci'),
					E('div', { 'id': 'active-clients-count', 'style': 'font-size: 28px; font-weight: bold; color: #9d4edd; margin-top: 5px;' }, '0')
				])
			]),

			// Table Section
			E('div', { 'class': 'cbi-section' }, [
				E('table', { 'class': 'table cbi-section-table', 'id': 'rate-table' }, [
					E('tr', { 'class': 'tr cbi-section-table-titles' }, [
						E('th', { 'class': 'th' }, _('Cihaz / Hostname')),
						E('th', { 'class': 'th' }, _('IP Adresi')),
						E('th', { 'class': 'th', 'style': 'width: 25%;' }, _('Anlık İndirme (Download)')),
						E('th', { 'class': 'th', 'style': 'width: 25%;' }, _('Anlık Yükleme (Upload)')),
						E('th', { 'class': 'th' }, _('Aktif Bağlantı')),
						E('th', { 'class': 'th' }, _('Toplam Trafik'))
					]),
					E('tbody', { 'id': 'rate-tbody' }, [
						E('tr', { 'class': 'tr placeholder' }, [
							E('td', { 'class': 'td', 'colspan': 6 }, E('em', {}, _('Canlı veriler hesaplanıyor... (1-2 saniye bekleyin)')))
						])
					])
				])
			])
		]);

		poll.add(L.bind(this.updateRates, this), 1);
		return viewNode;
	},

	updateRates: function() {
		return fs.exec_direct('/usr/libexec/nlbwmon-action', ['download', '-g', 'ip'], 'json').then(function(res) {
			if (!res || !res.data) return;

			var now = Date.now();
			var dt = lastTimestamp ? (now - lastTimestamp) / 1000 : 1;
			if (dt <= 0) dt = 1;
			lastTimestamp = now;

			var currentList = [];
			var totalDlRate = 0;
			var totalUlRate = 0;

			// columns: ["ip", "conns", "rx_bytes", "rx_pkts", "tx_bytes", "tx_pkts"]
			// For a gateway: tx_bytes = sent to client (Download), rx_bytes = received from client (Upload)
			for (var i = 0; i < res.data.length; i++) {
				var row = res.data[i];
				var ip = row[0];
				var conns = row[1];
				var clientUploadBytes = row[2];   // rx on gateway
				var clientDownloadBytes = row[4]; // tx from gateway

				// Skip router IP itself or modem
				if (ip === '192.168.31.2' || ip === '192.168.31.1') continue;

				var dlRate = 0;
				var ulRate = 0;

				if (prevStats[ip]) {
					var diffDl = clientDownloadBytes - prevStats[ip].dl;
					var diffUl = clientUploadBytes - prevStats[ip].ul;
					if (diffDl > 0) dlRate = diffDl / dt;
					if (diffUl > 0) ulRate = diffUl / dt;
				}

				prevStats[ip] = { dl: clientDownloadBytes, ul: clientUploadBytes };
				totalDlRate += dlRate;
				totalUlRate += ulRate;

				currentList.push({
					ip: ip,
					hostname: hostsMap[ip] || 'Cihaz (' + ip.split('.').slice(-1)[0] + ')',
					conns: conns,
					totalBytes: clientDownloadBytes + clientUploadBytes,
					dlRate: dlRate,
					ulRate: ulRate
				});
			}

			// Sort by total active speed descending
			currentList.sort(function(a, b) {
				return (b.dlRate + b.ulRate) - (a.dlRate + a.ulRate) || b.totalBytes - a.totalBytes;
			});

			var elDl = document.getElementById('total-dl-speed');
			var elUl = document.getElementById('total-ul-speed');
			var elCount = document.getElementById('active-clients-count');
			if (elDl) elDl.innerText = formatSpeed(totalDlRate);
			if (elUl) elUl.innerText = formatSpeed(totalUlRate);
			if (elCount) elCount.innerText = currentList.length;

			var tbody = document.getElementById('rate-tbody');
			if (!tbody) return;

			var rows = [];
			for (var k = 0; k < currentList.length; k++) {
				var item = currentList[k];
				var dlMbps = (item.dlRate * 8 / 1000000);
				var ulMbps = (item.ulRate * 8 / 1000000);

				var dlPct = Math.min(100, Math.max(0, (dlMbps / 65 * 100))).toFixed(1);
				var ulPct = Math.min(100, Math.max(0, (ulMbps / 15 * 100))).toFixed(1);

				rows.push(E('tr', { 'class': 'tr cbi-rowstyle-' + (k % 2 + 1) }, [
					E('td', { 'class': 'td', 'style': 'font-weight: bold;' }, item.hostname),
					E('td', { 'class': 'td' }, E('code', {}, item.ip)),
					E('td', { 'class': 'td' }, [
						E('div', { 'style': 'display: flex; justify-content: space-between; font-weight: bold; color: #0077b6;' }, [
							E('span', {}, formatSpeed(item.dlRate)),
							E('span', { 'style': 'font-size: 11px; color: #888;' }, dlPct + '%')
						]),
						E('div', { 'style': 'background: #e0e0e0; height: 6px; border-radius: 3px; overflow: hidden; margin-top: 4px;' }, [
							E('div', { 'style': 'background: #00b4d8; width: ' + dlPct + '%; height: 100%; transition: width 0.3s;' })
						])
					]),
					E('td', { 'class': 'td' }, [
						E('div', { 'style': 'display: flex; justify-content: space-between; font-weight: bold; color: #d90429;' }, [
							E('span', {}, formatSpeed(item.ulRate)),
							E('span', { 'style': 'font-size: 11px; color: #888;' }, ulPct + '%')
						]),
						E('div', { 'style': 'background: #e0e0e0; height: 6px; border-radius: 3px; overflow: hidden; margin-top: 4px;' }, [
							E('div', { 'style': 'background: #f77f00; width: ' + ulPct + '%; height: 100%; transition: width 0.3s;' })
						])
					]),
					E('td', { 'class': 'td' }, item.conns + ' conn'),
					E('td', { 'class': 'td' }, formatBytes(item.totalBytes))
				]));
			}

			dom.content(tbody, rows.length > 0 ? rows : E('tr', {}, E('td', { 'colspan': 6 }, _('Ağda aktif istemci bulunamadı.'))));
		}).catch(function(err) {
			console.error('realtime_rates error:', err);
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
