#ifndef VIDEODIALOG_H
#define VIDEODIALOG_H

#include <QDialog>
#include <QMediaPlayer>
#include <QVideoWidget>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QPushButton>
#include <QLabel>
#include <QTextEdit>
#include <QJsonObject>
#include "ApiClient.h"

class VideoDialog : public QDialog {
    Q_OBJECT
public:
    explicit VideoDialog(const QJsonObject& alert, ApiClient* client, QWidget *parent = nullptr);
    ~VideoDialog();

private slots:
    void submitClean();
    void submitDiscrepancy();
    void submitEscalate();

private:
    void setupUi();
    void submitDisposition(const QString& outcome);

    QJsonObject m_alert;
    ApiClient* m_client;
    
    QMediaPlayer* m_player;
    QVideoWidget* m_videoWidget;
    QTextEdit* m_remarksEdit;
    
    QPushButton* m_btnClean;
    QPushButton* m_btnDiscrepancy;
    QPushButton* m_btnEscalate;
};

#endif // VIDEODIALOG_H
