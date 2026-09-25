#include "ApiClient.h"
#include <QNetworkRequest>
#include <QUrl>
#include <QUrlQuery>

ApiClient::ApiClient(const QString& baseUrl, QObject *parent)
    : QObject(parent), m_baseUrl(baseUrl) {
    m_manager = new QNetworkAccessManager(this);
}

void ApiClient::fetchAlerts() {
    QNetworkRequest request(QUrl(m_baseUrl + "/api/v1/alerts"));
    QNetworkReply *reply = m_manager->get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        try {
            if (reply->error() == QNetworkReply::NoError) {
                QJsonParseError parseError;
                QJsonDocument doc = QJsonDocument::fromJson(reply->readAll(), &parseError);
                if (parseError.error != QJsonParseError::NoError) {
                    throw std::runtime_error("JSON Parse Error: " + parseError.errorString().toStdString());
                }
                if (!doc.isArray()) {
                    throw std::runtime_error("Expected JSON array for alerts");
                }
                emit alertsFetched(doc.array());
            } else {
                throw std::runtime_error("Alerts Fetch Error: " + reply->errorString().toStdString());
            }
        } catch (const std::exception& e) {
            emit errorOccurred(e.what());
        }
        reply->deleteLater();
    });
}

void ApiClient::fetchCounters() {
    QNetworkRequest request(QUrl(m_baseUrl + "/api/v1/counters"));
    QNetworkReply *reply = m_manager->get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        try {
            if (reply->error() == QNetworkReply::NoError) {
                QJsonParseError parseError;
                QJsonDocument doc = QJsonDocument::fromJson(reply->readAll(), &parseError);
                if (parseError.error != QJsonParseError::NoError) {
                    throw std::runtime_error("JSON Parse Error: " + parseError.errorString().toStdString());
                }
                if (!doc.isArray()) {
                    throw std::runtime_error("Expected JSON array for counters");
                }
                emit countersFetched(doc.array());
            } else {
                throw std::runtime_error("Counters Fetch Error: " + reply->errorString().toStdString());
            }
        } catch (const std::exception& e) {
            emit errorOccurred(e.what());
        }
        reply->deleteLater();
    });
}

void ApiClient::fetchLatestFrame() {
    QNetworkRequest request(QUrl(m_baseUrl + "/api/v1/latest-frame.jpg"));
    QNetworkReply *reply = m_manager->get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        try {
            if (reply->error() == QNetworkReply::NoError) {
                QByteArray data = reply->readAll();
                if (data.isEmpty()) {
                    throw std::runtime_error("Stream input error: Empty frame received");
                }
                emit latestFrameFetched(data);
            } else {
                throw std::runtime_error("Stream connection error: " + reply->errorString().toStdString());
            }
        } catch (const std::exception& e) {
            emit streamErrorOccurred(QString::fromStdString(e.what()));
        }
        reply->deleteLater();
    });
}

void ApiClient::startTransaction(const QJsonObject& payload) {
    QNetworkRequest request(QUrl(m_baseUrl + "/api/v1/transaction/start"));
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    QNetworkReply *reply = m_manager->post(request, QJsonDocument(payload).toJson());
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        try {
            if (reply->error() == QNetworkReply::NoError) {
                QJsonParseError parseError;
                QJsonDocument doc = QJsonDocument::fromJson(reply->readAll(), &parseError);
                if (parseError.error != QJsonParseError::NoError) {
                    throw std::runtime_error("JSON Parse Error: " + parseError.errorString().toStdString());
                }
                emit transactionStarted(doc.object());
            } else {
                throw std::runtime_error("Transaction Start Error: " + reply->errorString().toStdString());
            }
        } catch (const std::exception& e) {
            emit errorOccurred(e.what());
        }
        reply->deleteLater();
    });
}

void ApiClient::endTransaction(const QString& transactionId, double amount) {
    QNetworkRequest request(QUrl(m_baseUrl + "/api/v1/transaction/end"));
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    QJsonObject payload;
    payload["transaction_id"] = transactionId;
    payload["amount"] = amount;
    QNetworkReply *reply = m_manager->post(request, QJsonDocument(payload).toJson());
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        try {
            if (reply->error() == QNetworkReply::NoError) {
                QJsonParseError parseError;
                QJsonDocument doc = QJsonDocument::fromJson(reply->readAll(), &parseError);
                if (parseError.error != QJsonParseError::NoError) {
                    throw std::runtime_error("JSON Parse Error: " + parseError.errorString().toStdString());
                }
                emit transactionEnded(doc.object());
            } else {
                throw std::runtime_error("Transaction End Error: " + reply->errorString().toStdString());
            }
        } catch (const std::exception& e) {
            emit errorOccurred(e.what());
        }
        reply->deleteLater();
    });
}

void ApiClient::saveDisposition(int alertId, const QString& outcome, const QString& remarks) {
    QNetworkRequest request(QUrl(QString("%1/api/v1/alerts/%2/disposition").arg(m_baseUrl).arg(alertId)));
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    QJsonObject payload;
    payload["outcome"] = outcome;
    payload["remarks"] = remarks;
    QNetworkReply *reply = m_manager->post(request, QJsonDocument(payload).toJson());
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        try {
            if (reply->error() == QNetworkReply::NoError) {
                emit dispositionSaved();
            } else {
                throw std::runtime_error("Disposition Save Error: " + reply->errorString().toStdString());
            }
        } catch (const std::exception& e) {
            emit errorOccurred(e.what());
        }
        reply->deleteLater();
    });
}
