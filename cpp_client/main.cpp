#include <QApplication>
#include <QInputDialog>
#include <QMessageBox>
#include <QFile>
#include <QTextStream>
#include <QDateTime>
#include <QMutex>
#include "MainWindow.h"

void customMessageHandler(QtMsgType type, const QMessageLogContext &context, const QString &msg) {
    static QMutex mutex;
    QMutexLocker locker(&mutex);
    
    QFile outFile("client.log");
    outFile.open(QIODevice::WriteOnly | QIODevice::Append);
    QTextStream ts(&outFile);
    
    QString txt = QDateTime::currentDateTime().toString("yyyy-MM-dd hh:mm:ss.zzz ");
    switch (type) {
        case QtDebugMsg:    txt += QString("[Debug] "); break;
        case QtInfoMsg:     txt += QString("[Info] "); break;
        case QtWarningMsg:  txt += QString("[Warning] "); break;
        case QtCriticalMsg: txt += QString("[Critical] "); break;
        case QtFatalMsg:    txt += QString("[Fatal] "); break;
    }
    
    txt += msg;
    ts << txt << Qt::endl;
    
    // Also print to console
    fprintf(stderr, "%s\n", txt.toLocal8Bit().constData());
    fflush(stderr);
}


int main(int argc, char *argv[]) {
    qInstallMessageHandler(customMessageHandler);
    QApplication app(argc, argv);
    
    bool ok;
    QString backendUrl = QInputDialog::getText(nullptr, "SmartCare Client",
                                               "Enter Backend URL:", QLineEdit::Normal,
                                               "http://localhost:5000", &ok);
    
    if (!ok || backendUrl.isEmpty()) {
        QMessageBox::critical(nullptr, "Error", "Backend URL is required to start the client.");
        return 1;
    }
    
    MainWindow w(backendUrl);
    w.show();
    
    return app.exec();
}
