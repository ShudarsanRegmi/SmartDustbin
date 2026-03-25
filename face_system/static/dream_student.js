let studentCharts = {};
let studentRange = { start: null, end: null };

function resetStudentChart(key) {
  if (studentCharts[key]) studentCharts[key].destroy();
}

function renderStudentCharts(data) {
  resetStudentChart('trend');
  studentCharts.trend = new Chart(document.getElementById('studentTrendChart'), {
    type: 'line',
    data: {
      labels: data.daily.map((d) => d.label),
      datasets: [
        { label: 'Avg Waste', data: data.daily.map((d) => d.avg_waste), borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,.2)', fill: true, tension: 0.3, yAxisID: 'y' },
        { type: 'bar', label: 'Events', data: data.daily.map((d) => d.events), backgroundColor: 'rgba(99,102,241,.26)', yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#c8d4ef' } } },
      scales: {
        x: { ticks: { color: '#93a7ca', maxTicksLimit: 9 } },
        y: { min: 1, max: 4, ticks: { color: '#93a7ca' } },
        y1: { position: 'right', ticks: { color: '#93a7ca' }, grid: { drawOnChartArea: false } },
      },
    },
  });

  const cat = data.summary.cat;
  resetStudentChart('cat');
  studentCharts.cat = new Chart(document.getElementById('studentCategoryChart'), {
    type: 'doughnut',
    data: {
      labels: ['Category 1', 'Category 2', 'Category 3', 'Category 4'],
      datasets: [{ data: [cat['1'], cat['2'], cat['3'], cat['4']], backgroundColor: ['#ef4444', '#f59e0b', '#60a5fa', '#22c55e'] }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#c8d4ef' } } },
    },
  });
}

function renderStudent(data) {
  document.getElementById('studentName').textContent = data.profile.name;
  document.getElementById('studentAvatar').src = data.profile.avatar;
  document.getElementById('studentMeta').textContent = `Hostel ${data.profile.hostel} | All-time Avg Waste: ${data.profile.all_time_avg_waste}`;
  document.getElementById('studentGreenCredits').textContent = `Green Credits: ${data.profile.green_credits}`;
  document.getElementById('studentAllTimeEvents').textContent = `All-time Events: ${data.profile.all_time_events}`;

  document.getElementById('studentEvents').textContent = data.summary.events;
  document.getElementById('studentAvgWaste').textContent = data.summary.avg_waste;
  document.getElementById('studentRisk').textContent = `${data.summary.risk_score}%`;
  document.getElementById('studentCatMix').textContent = `${data.summary.cat['1']}/${data.summary.cat['2']}/${data.summary.cat['3']}/${data.summary.cat['4']}`;

  document.getElementById('studentStartDate').value = data.range.start;
  document.getElementById('studentEndDate').value = data.range.end;
  document.getElementById('studentStartDate').min = data.range.min;
  document.getElementById('studentStartDate').max = data.range.max;
  document.getElementById('studentEndDate').min = data.range.min;
  document.getElementById('studentEndDate').max = data.range.max;

  const records = document.getElementById('studentPlateRecords');
  records.innerHTML = (data.plate_records || []).map((r) => `
    <article class="dream-record-card">
      <img src="${r.plate_photo}" alt="plate" loading="lazy" />
      <div class="dream-record-info">
        <div>${r.date}</div>
        <div>Category ${r.category} | Waste ${r.waste_value}</div>
        <div>Green Delta: ${r.green_credit_delta > 0 ? '+' : ''}${r.green_credit_delta}</div>
      </div>
    </article>
  `).join('');

  renderStudentCharts(data);
}

async function loadStudent() {
  const studentName = document.body.dataset.dreamStudent || '';
  const params = new URLSearchParams();
  if (studentRange.start) params.set('start_date', studentRange.start);
  if (studentRange.end) params.set('end_date', studentRange.end);
  const url = `/api/dream/student/${encodeURIComponent(studentName)}${params.toString() ? '?' + params.toString() : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Unable to load student analytics');
  const data = await res.json();
  renderStudent(data);
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    document.getElementById('studentApplyRangeBtn').addEventListener('click', async () => {
      studentRange.start = document.getElementById('studentStartDate').value || null;
      studentRange.end = document.getElementById('studentEndDate').value || null;
      await loadStudent();
    });
    await loadStudent();
  } catch (err) {
    console.error(err);
  }
});
