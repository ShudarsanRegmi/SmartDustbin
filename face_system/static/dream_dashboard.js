let dreamCharts = {};
let dreamCurrentRange = { start: null, end: null };

function dreamFmt(num) {
  return new Intl.NumberFormat('en-IN').format(num);
}

function dreamRiskTone(score) {
  if (score >= 75) return '#f87171';
  if (score >= 55) return '#fbbf24';
  return '#4ade80';
}

function resetChart(key) {
  if (dreamCharts[key]) dreamCharts[key].destroy();
}

function renderKpis(kpis, profiles) {
  const avgCredits = profiles.length
    ? (profiles.reduce((s, p) => s + p.green_credits, 0) / profiles.length).toFixed(1)
    : '0.0';
  document.getElementById('kpiTotalEvents').textContent = dreamFmt(kpis.total_events);
  document.getElementById('kpiDailyEvents').textContent = kpis.avg_daily_events;
  document.getElementById('kpiWasteIndex').textContent = kpis.overall_avg_waste;
  document.getElementById('kpiMoM').textContent = `${kpis.month_change_pct > 0 ? '+' : ''}${kpis.month_change_pct}%`;
  document.getElementById('kpiGreenCredits').textContent = avgCredits;
  document.getElementById('dreamProfilesBadge').textContent = `Profiles: ${kpis.active_profiles}`;
}

function renderInsights(items) {
  const el = document.getElementById('dreamInsights');
  el.innerHTML = items.map((i) => `<li>${i}</li>`).join('');
}

function renderPeople(list, containerId) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = list.map((p, idx) => `
    <article class="dream-person">
      <img src="${p.avatar}" alt="${p.name}" />
      <div>
        <div class="dream-person-name">#${idx + 1} ${p.name}</div>
        <div class="dream-person-meta">${p.events} events, Hostel ${p.hostel || '-'}</div>
      </div>
      <div class="dream-risk" style="color:${dreamRiskTone(p.risk_score)}">${p.avg_waste}</div>
    </article>
  `).join('');
}

function renderProfileTable(profiles) {
  const body = document.querySelector('#dreamProfileTable tbody');
  body.innerHTML = profiles.map((p) => `
    <tr class="dream-click-row" data-url="${p.detail_url}">
      <td>
        <div class="dream-profile-cell">
          <img src="${p.avatar}" alt="${p.name}" />
          <span>${p.name}</span>
        </div>
      </td>
      <td>${p.hostel}</td>
      <td>${p.events}</td>
      <td>${p.avg_waste}</td>
      <td>${p.green_credits}</td>
      <td><span class="dream-badge" style="border-color:${dreamRiskTone(p.risk_score)}55;color:${dreamRiskTone(p.risk_score)}">${p.risk_score}%</span></td>
      <td>${p.cat['1']}/${p.cat['2']}/${p.cat['3']}/${p.cat['4']}</td>
    </tr>
  `).join('');

  body.querySelectorAll('tr[data-url]').forEach((row) => {
    row.addEventListener('click', () => {
      window.location.href = row.getAttribute('data-url');
    });
  });
}

function renderProfileDirectory(profiles) {
  const el = document.getElementById('dreamProfileDirectory');
  el.innerHTML = profiles.map((p) => `
    <a class="dream-profile-card" href="${p.detail_url}">
      <img src="${p.avatar}" alt="${p.name}" />
      <div>
        <div class="dream-person-name">${p.name}</div>
        <div class="meta">Hostel ${p.hostel} | Credits ${p.green_credits}</div>
      </div>
    </a>
  `).join('');
}

function renderHostelTable(hostels) {
  const body = document.querySelector('#dreamHostelTable tbody');
  body.innerHTML = hostels.map((h) => `
    <tr>
      <td>${h.hostel}</td>
      <td>${h.profiles}</td>
      <td>${h.events}</td>
      <td>${h.avg_waste}</td>
      <td>${h.green_credits_avg}</td>
    </tr>
  `).join('');
}

function renderCharts(data) {
  const daily = data.daily_last_30;
  const monthly = data.monthly_last_12;
  const weekday = data.weekday;
  const category = data.current_category_distribution;
  const hostels = data.hostels;

  resetChart('daily');
  dreamCharts.daily = new Chart(document.getElementById('dailyWasteChart'), {
    type: 'line',
    data: {
      labels: daily.map((d) => d.label),
      datasets: [
        { label: 'Avg Waste', data: daily.map((d) => d.avg_waste), borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,.2)', fill: true, tension: 0.35, yAxisID: 'y' },
        { type: 'bar', label: 'Events', data: daily.map((d) => d.events), backgroundColor: 'rgba(74,222,128,.22)', yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#c8d4ef' } } },
      scales: {
        x: { ticks: { color: '#93a7ca', maxTicksLimit: 8 }, grid: { color: 'rgba(148,163,184,.08)' } },
        y: { min: 1, max: 4, ticks: { color: '#93a7ca' }, grid: { color: 'rgba(148,163,184,.08)' } },
        y1: { position: 'right', ticks: { color: '#93a7ca' }, grid: { drawOnChartArea: false } },
      },
    },
  });

  resetChart('monthly');
  dreamCharts.monthly = new Chart(document.getElementById('monthlyTrendChart'), {
    type: 'bar',
    data: {
      labels: monthly.map((m) => m.label),
      datasets: [
        { label: 'Events', data: monthly.map((m) => m.events), backgroundColor: 'rgba(99,102,241,.45)', yAxisID: 'y' },
        { type: 'line', label: 'Avg Waste', data: monthly.map((m) => m.avg_waste), borderColor: '#f59e0b', tension: 0.35, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#c8d4ef' } } },
      scales: {
        x: { ticks: { color: '#93a7ca' }, grid: { color: 'rgba(148,163,184,.07)' } },
        y: { ticks: { color: '#93a7ca' }, grid: { color: 'rgba(148,163,184,.07)' } },
        y1: { position: 'right', min: 1, max: 4, ticks: { color: '#93a7ca' }, grid: { drawOnChartArea: false } },
      },
    },
  });

  resetChart('category');
  dreamCharts.category = new Chart(document.getElementById('categoryMixChart'), {
    type: 'doughnut',
    data: {
      labels: ['Category 1', 'Category 2', 'Category 3', 'Category 4'],
      datasets: [{ data: [category['1'], category['2'], category['3'], category['4']], backgroundColor: ['#ef4444', '#f59e0b', '#60a5fa', '#22c55e'] }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: '#c8d4ef' } } } },
  });

  resetChart('weekday');
  dreamCharts.weekday = new Chart(document.getElementById('weekdayChart'), {
    type: 'radar',
    data: {
      labels: weekday.map((w) => w.weekday),
      datasets: [{ label: 'Avg Waste by Weekday', data: weekday.map((w) => w.avg_waste), borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,.25)' }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#c8d4ef' } } },
      scales: { r: { min: 1, max: 4, angleLines: { color: 'rgba(148,163,184,.18)' }, grid: { color: 'rgba(148,163,184,.18)' }, pointLabels: { color: '#a9b9d7' }, ticks: { color: '#8ea2c7', backdropColor: 'transparent' } } },
    },
  });

  resetChart('hostelWaste');
  dreamCharts.hostelWaste = new Chart(document.getElementById('hostelWasteChart'), {
    type: 'bar',
    data: {
      labels: hostels.map((h) => h.hostel),
      datasets: [{ label: 'Avg Waste', data: hostels.map((h) => h.avg_waste), backgroundColor: 'rgba(239,68,68,.5)' }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#c8d4ef' } } }, scales: { x: { ticks: { color: '#93a7ca' } }, y: { min: 1, max: 4, ticks: { color: '#93a7ca' } } } },
  });

  resetChart('hostelCredits');
  dreamCharts.hostelCredits = new Chart(document.getElementById('hostelCreditsChart'), {
    type: 'bar',
    data: {
      labels: hostels.map((h) => h.hostel),
      datasets: [{ label: 'Avg Green Credits', data: hostels.map((h) => h.green_credits_avg), backgroundColor: 'rgba(34,197,94,.5)' }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#c8d4ef' } } }, scales: { x: { ticks: { color: '#93a7ca' } }, y: { ticks: { color: '#93a7ca' } } } },
  });
}

function switchTab(tabName) {
  const tabMap = {
    overview: 'dreamTabOverview',
    hostels: 'dreamTabHostels',
    profiles: 'dreamTabProfiles',
  };
  document.querySelectorAll('.dream-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tabName));
  Object.keys(tabMap).forEach((k) => {
    const el = document.getElementById(tabMap[k]);
    if (!el) return;
    el.style.display = k === tabName ? '' : 'none';
  });
}

async function loadDreamDashboard() {
  const params = new URLSearchParams();
  if (dreamCurrentRange.start) params.set('start_date', dreamCurrentRange.start);
  if (dreamCurrentRange.end) params.set('end_date', dreamCurrentRange.end);
  const url = params.toString() ? `/api/dream/analytics?${params.toString()}` : '/api/dream/analytics';

  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to load dream analytics');
  const data = await res.json();

  dreamCurrentRange.start = data.range.start;
  dreamCurrentRange.end = data.range.end;
  document.getElementById('dreamStartDate').value = data.range.start;
  document.getElementById('dreamEndDate').value = data.range.end;
  document.getElementById('dreamStartDate').min = data.range.min;
  document.getElementById('dreamStartDate').max = data.range.max;
  document.getElementById('dreamEndDate').min = data.range.min;
  document.getElementById('dreamEndDate').max = data.range.max;
  document.getElementById('dreamPeriodBadge').textContent = `${data.range.start} to ${data.range.end}`;

  renderKpis(data.kpis, data.profiles || []);
  renderInsights(data.insights || []);
  renderPeople(data.leaderboards.top_wasters || [], 'topWastersList');
  renderPeople(data.leaderboards.least_wasters || [], 'leastWastersList');
  renderProfileTable(data.profiles || []);
  renderProfileDirectory(data.profiles || []);
  renderHostelTable(data.hostels || []);
  renderCharts(data);
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    document.querySelectorAll('.dream-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    document.getElementById('dreamApplyRangeBtn').addEventListener('click', async () => {
      dreamCurrentRange.start = document.getElementById('dreamStartDate').value || null;
      dreamCurrentRange.end = document.getElementById('dreamEndDate').value || null;
      await loadDreamDashboard();
    });
    await loadDreamDashboard();
  } catch (err) {
    console.error(err);
    const wrap = document.querySelector('.dream-wrap');
    if (wrap) {
      const error = document.createElement('div');
      error.className = 'status-box error';
      error.textContent = 'Failed to load analytics demo data.';
      wrap.prepend(error);
    }
  }
});
