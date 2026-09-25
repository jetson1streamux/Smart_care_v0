#ifndef MAINWINDOW_H
#define MAINWINDOW_H

#include <QMainWindow>
#include <QTableWidget>
#include <QLabel>
#include <QPushButton>
#include <QComboBox>
#include <QLineEdit>
#include <QTimer>
#include "ApiClient.h"

class MainWindow : public QMainWindow {
    Q_OBJECT

public:
    explicit MainWindow(const QString& backendUrl, QWidget *parent = nullptr);
    ~MainWindow();

private slots:
    void onAlertsFetched(const QJsonArray& alerts);
    void onCountersFetched(const QJsonArray& counters);
    void onLatestFrameFetched(const QByteArray& jpegData);
    void onTransactionStarted(const QJsonObject& response);
    void onTransactionEnded(const QJsonObject& response);
    void onInvestigateClicked();
    void onApiError(const QString& error);
    void onStreamError(const QString& error);

    void startTxnSim();
    void endTxnSim();

private:
    void setupUi();
    
    ApiClient* m_client;
    QTimer* m_pollTimer;
    QTimer* m_frameTimer;
    QString m_activeTxnId;

    QJsonArray m_currentAlerts;

    // UI Elements
    QLabel* m_lblHighRisk;
    QLabel* m_lblMediumRisk;
    QLabel* m_lblGap;
    
    QLabel* m_liveCamView;

    QComboBox* m_simCounter;
    QLineEdit* m_simStaff;
    QComboBox* m_simModule;
    QComboBox* m_simAction;
    QLineEdit* m_simAmount;
    QPushButton* m_btnStartTxn;
    QPushButton* m_btnEndTxn;

    QTableWidget* m_alertTable;
    bool m_apiErrorShown = false;
};

#endif // MAINWINDOW_H
