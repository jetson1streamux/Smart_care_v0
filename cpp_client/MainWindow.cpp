#include "MainWindow.h"
#include "VideoDialog.h"
#include <QHBoxLayout>
#include <QVBoxLayout>
#include <QFormLayout>
#include <QGroupBox>
#include <QHeaderView>
#include <QMessageBox>
#include <QPixmap>
#include <QDebug>

MainWindow::MainWindow(const QString& backendUrl, QWidget *parent)
    : QMainWindow(parent) {
    
    m_client = new ApiClient(backendUrl, this);
    
    connect(m_client, &ApiClient::alertsFetched, this, &MainWindow::onAlertsFetched);
    connect(m_client, &ApiClient::countersFetched, this, &MainWindow::onCountersFetched);
    connect(m_client, &ApiClient::latestFrameFetched, this, &MainWindow::onLatestFrameFetched);
    connect(m_client, &ApiClient::transactionStarted, this, &MainWindow::onTransactionStarted);
    connect(m_client, &ApiClient::transactionEnded, this, &MainWindow::onTransactionEnded);
    connect(m_client, &ApiClient::errorOccurred, this, &MainWindow::onApiError);
    connect(m_client, &ApiClient::streamErrorOccurred, this, &MainWindow::onStreamError);
    
    setupUi();

    m_pollTimer = new QTimer(this);
    connect(m_pollTimer, &QTimer::timeout, this, [this]() {
        m_client->fetchAlerts();
        m_client->fetchCounters();
    });
    m_pollTimer->start(3000);
    
    m_frameTimer = new QTimer(this);
    connect(m_frameTimer, &QTimer::timeout, m_client, &ApiClient::fetchLatestFrame);
    m_frameTimer->start(500); // 2 FPS to not overload network
    
    // Initial fetch
    m_client->fetchAlerts();
    m_client->fetchCounters();
}

MainWindow::~MainWindow() {}

void MainWindow::setupUi() {
    setWindowTitle("SmartCare RBATPM - Native Client");
    resize(1280, 720);
    
    QWidget* central = new QWidget(this);
    setCentralWidget(central);
    
    QVBoxLayout* mainLayout = new QVBoxLayout(central);
    
    // KPI Strip
    QHBoxLayout* kpiLayout = new QHBoxLayout();
    m_lblHighRisk = new QLabel("High Risk: 0");
    m_lblMediumRisk = new QLabel("Medium Risk: 0");
    m_lblGap = new QLabel("Monitoring Gap: 0");
    m_lblHighRisk->setStyleSheet("font-weight: bold; color: red; padding: 10px; background: #ffebeb;");
    m_lblMediumRisk->setStyleSheet("font-weight: bold; color: orange; padding: 10px; background: #fff4e6;");
    m_lblGap->setStyleSheet("font-weight: bold; color: purple; padding: 10px; background: #f3e6ff;");
    kpiLayout->addWidget(m_lblHighRisk);
    kpiLayout->addWidget(m_lblMediumRisk);
    kpiLayout->addWidget(m_lblGap);
    mainLayout->addLayout(kpiLayout);
    
    // 3 Columns layout
    QHBoxLayout* colsLayout = new QHBoxLayout();
    
    // Col 1: Live Stream
    QVBoxLayout* col1 = new QVBoxLayout();
    QGroupBox* gbLive = new QGroupBox("Live Camera Feed");
    QVBoxLayout* liveLayout = new QVBoxLayout(gbLive);
    m_liveCamView = new QLabel("Waiting for stream...");
    m_liveCamView->setMinimumSize(320, 240);
    m_liveCamView->setAlignment(Qt::AlignCenter);
    m_liveCamView->setStyleSheet("background: black; color: white;");
    liveLayout->addWidget(m_liveCamView);
    col1->addWidget(gbLive);
    col1->addStretch();
    colsLayout->addLayout(col1, 1);
    
    // Col 2: Simulator
    QVBoxLayout* col2 = new QVBoxLayout();
    QGroupBox* gbSim = new QGroupBox("Transaction Simulator");
    QFormLayout* formSim = new QFormLayout(gbSim);
    
    m_simStaff = new QLineEdit("STF102");
    m_simCounter = new QComboBox();
    m_simModule = new QComboBox();
    m_simModule->addItems({"Billing", "Pharmacy", "Stores"});
    m_simAction = new QComboBox();
    m_simAction->addItems({"Refund", "Discount Override"});
    m_simAmount = new QLineEdit("5000");
    
    formSim->addRow("Staff ID", m_simStaff);
    formSim->addRow("Counter", m_simCounter);
    formSim->addRow("Module", m_simModule);
    formSim->addRow("Action", m_simAction);
    formSim->addRow("End Amount (₹)", m_simAmount);
    
    m_btnStartTxn = new QPushButton("Start Transaction");
    m_btnEndTxn = new QPushButton("End Transaction");
    m_btnEndTxn->setEnabled(false);
    
    formSim->addRow(m_btnStartTxn, m_btnEndTxn);
    connect(m_btnStartTxn, &QPushButton::clicked, this, &MainWindow::startTxnSim);
    connect(m_btnEndTxn, &QPushButton::clicked, this, &MainWindow::endTxnSim);
    
    col2->addWidget(gbSim);
    col2->addStretch();
    colsLayout->addLayout(col2, 1);
    
    // Col 3: Alert Queue
    QVBoxLayout* col3 = new QVBoxLayout();
    QGroupBox* gbAlerts = new QGroupBox("Alert Triage Queue");
    QVBoxLayout* alertsLayout = new QVBoxLayout(gbAlerts);
    m_alertTable = new QTableWidget(0, 7);
    m_alertTable->setHorizontalHeaderLabels({"ID", "Action", "Risk", "Counter", "Staff", "Status", "Action"});
    m_alertTable->horizontalHeader()->setSectionResizeMode(QHeaderView::Stretch);
    alertsLayout->addWidget(m_alertTable);
    col3->addWidget(gbAlerts);
    colsLayout->addLayout(col3, 2);
    
    mainLayout->addLayout(colsLayout);
}

void MainWindow::onLatestFrameFetched(const QByteArray& jpegData) {
    try {
        QPixmap pixmap;
        if (pixmap.loadFromData(jpegData, "JPG")) {
            m_liveCamView->setPixmap(pixmap.scaled(m_liveCamView->size(), Qt::KeepAspectRatio, Qt::SmoothTransformation));
        } else {
            throw std::runtime_error("Failed to decode stream JPEG data.");
        }
    } catch (const std::exception& e) {
        onStreamError(e.what());
    }
}

void MainWindow::onCountersFetched(const QJsonArray& counters) {
    QString current = m_simCounter->currentText();
    m_simCounter->clear();
    for (int i = 0; i < counters.size(); ++i) {
        QJsonObject c = counters[i].toObject();
        m_simCounter->addItem(c["counter_id"].toString());
    }
    if (!current.isEmpty()) {
        m_simCounter->setCurrentText(current);
    }
}

void MainWindow::onAlertsFetched(const QJsonArray& alerts) {
    m_apiErrorShown = false; // Reset on successful fetch
    m_currentAlerts = alerts;
    m_alertTable->setRowCount(alerts.size());
    
    int high = 0; int med = 0; int gap = 0;
    
    for (int i = 0; i < alerts.size(); ++i) {
        QJsonObject a = alerts[i].toObject();
        QString risk = a["risk_score"].toString();
        
        if (risk == "High" && a["flag"].toString() != "monitoring_gap") high++;
        else if (risk == "Medium") med++;
        if (a["flag"].toString() == "monitoring_gap") gap++;
        
        m_alertTable->setItem(i, 0, new QTableWidgetItem(a["id"].toVariant().toString()));
        m_alertTable->setItem(i, 1, new QTableWidgetItem(a["action_type"].toString()));
        m_alertTable->setItem(i, 2, new QTableWidgetItem(risk));
        m_alertTable->setItem(i, 3, new QTableWidgetItem(a["counter_id"].toString()));
        m_alertTable->setItem(i, 4, new QTableWidgetItem(a["staff_id"].toString()));
        m_alertTable->setItem(i, 5, new QTableWidgetItem(a["reviewer_status"].toString()));
        
        QPushButton* btnInv = new QPushButton("Investigate");
        btnInv->setProperty("alertIndex", i);
        connect(btnInv, &QPushButton::clicked, this, &MainWindow::onInvestigateClicked);
        m_alertTable->setCellWidget(i, 6, btnInv);
    }
    
    m_lblHighRisk->setText(QString("High Risk: %1").arg(high));
    m_lblMediumRisk->setText(QString("Medium Risk: %1").arg(med));
    m_lblGap->setText(QString("Monitoring Gap: %1").arg(gap));
}

void MainWindow::onInvestigateClicked() {
    QPushButton* btn = qobject_cast<QPushButton*>(sender());
    if (!btn) return;
    int index = btn->property("alertIndex").toInt();
    if (index >= 0 && index < m_currentAlerts.size()) {
        QJsonObject alert = m_currentAlerts[index].toObject();
        VideoDialog* dlg = new VideoDialog(alert, m_client, this);
        dlg->setAttribute(Qt::WA_DeleteOnClose);
        dlg->show();
    }
}

void MainWindow::startTxnSim() {
    QJsonObject payload;
    payload["staff_id"] = m_simStaff->text();
    payload["counter_id"] = m_simCounter->currentText();
    payload["module"] = m_simModule->currentText();
    payload["action_type"] = m_simAction->currentText();
    payload["subscription"] = "Y";
    payload["pre_buffer_sec"] = 5;
    payload["post_buffer_sec"] = 5;
    
    m_btnStartTxn->setEnabled(false);
    m_client->startTransaction(payload);
}

void MainWindow::onTransactionStarted(const QJsonObject& response) {
    if (response["status"].toString() == "recording_started") {
        m_activeTxnId = response["transaction_id"].toString();
        m_btnEndTxn->setEnabled(true);
    } else {
        m_btnStartTxn->setEnabled(true);
        QMessageBox::warning(this, "Sim", "Transaction failed or gap detected.");
    }
}

void MainWindow::endTxnSim() {
    if (!m_activeTxnId.isEmpty()) {
        m_btnEndTxn->setEnabled(false);
        double amount = m_simAmount->text().toDouble();
        m_client->endTransaction(m_activeTxnId, amount);
    }
}

void MainWindow::onTransactionEnded(const QJsonObject& response) {
    m_activeTxnId.clear();
    m_btnStartTxn->setEnabled(true);
}

void MainWindow::onApiError(const QString& error) {
    qWarning() << "API Error:" << error;
    if (!m_apiErrorShown) {
        m_apiErrorShown = true;
        QMessageBox::critical(this, "API Connection Error", "No API connection: " + error);
    }
}

void MainWindow::onStreamError(const QString& error) {
    qWarning() << "Stream Error:" << error;
    m_liveCamView->setText(QString("Stream Error: ") + error);
}
