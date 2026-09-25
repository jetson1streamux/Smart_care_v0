#ifndef APICLIENT_H
#define APICLIENT_H

#include <QObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QString>

class ApiClient : public QObject {
    Q_OBJECT
public:
    explicit ApiClient(const QString& baseUrl, QObject *parent = nullptr);
    
    void fetchAlerts();
    void fetchCounters();
    void fetchLatestFrame();
    void startTransaction(const QJsonObject& payload);
    void endTransaction(const QString& transactionId, double amount = 0.0);
    void saveDisposition(int alertId, const QString& outcome, const QString& remarks);
    
    QString getBaseUrl() const { return m_baseUrl; }

signals:
    void alertsFetched(const QJsonArray& alerts);
    void countersFetched(const QJsonArray& counters);
    void latestFrameFetched(const QByteArray& jpegData);
    void transactionStarted(const QJsonObject& response);
    void transactionEnded(const QJsonObject& response);
    void dispositionSaved();
    void errorOccurred(const QString& error);
    void streamErrorOccurred(const QString& error);

private:
    QNetworkAccessManager *m_manager;
    QString m_baseUrl;
};

#endif // APICLIENT_H
